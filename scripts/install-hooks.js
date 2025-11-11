#!/usr/bin/env node

/**
 * Git Hooks Installer
 * Sets up pre-push hooks to validate code before pushing
 */

const fs = require('fs');
const path = require('path');

const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Commit-msg hook content - validates commit message format
const commitMsgHook = `#!/bin/bash

# Commit-msg hook to validate commit message format
# Ensures commits follow conventional commits format

COMMIT_MSG_FILE=$1
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Skip validation for merge commits
if echo "$COMMIT_MSG" | grep -qE "^Merge (branch|pull request)"; then
  exit 0
fi

# Run commitlint - check if npx is available
# First try to find Node.js in common locations
if [ -f "$HOME/.nvm/versions/node/v20.19.1/bin/npx" ]; then
  NPX_CMD="$HOME/.nvm/versions/node/v20.19.1/bin/npx"
elif command -v npx >/dev/null 2>&1; then
  NPX_CMD="npx"
elif [ -f "/opt/homebrew/bin/npx" ]; then
  NPX_CMD="/opt/homebrew/bin/npx"
elif [ -f "/usr/local/bin/npx" ]; then
  NPX_CMD="/usr/local/bin/npx"
else
  NPX_CMD=""
fi

# Run commitlint using the project's local installation
if [ -n "$NPX_CMD" ]; then
  # Change to the project directory to ensure we use local node_modules
  cd "$(dirname "$0")/../.." || exit 1

  echo "$COMMIT_MSG" | $NPX_CMD commitlint --config commitlint.config.js
  COMMITLINT_EXIT=$?
else
  echo "❌ npx not found - Node.js is required for commit message validation"
  echo "   Install Node.js or ensure npx is in your PATH"
  exit 1
fi

if [ $COMMITLINT_EXIT -ne 0 ]; then
  echo ""
  echo "❌ Commit message does not follow conventional commits format!"
  echo ""
  echo "📝 Format: <type>: <description>"
  echo ""
  echo "Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore"
  echo ""
  echo "Examples:"
  echo "  feat: add new feature"
  echo "  fix: resolve bug in authentication"
  echo "  docs: update README"
  echo ""
  exit 1
fi
`;

// Pre-push hook content
const prePushHook = `#!/bin/bash

# Pre-push hook to validate code before pushing
# Goal: Fast validation (<10s) - CI will run comprehensive checks

echo "🔍 Running pre-push validation..."

# Only run essential fast checks locally:
# 1. TypeScript compilation (catches syntax/type errors)
# 2. Build (ensures code compiles)
# 3. Skip schema sync (too slow, CI will catch issues)
# 4. Skip tests (too slow, CI will catch issues)

echo "📝 Checking TypeScript types..."
npm run typecheck
if [ $? -ne 0 ]; then
  echo ""
  echo "❌ TypeScript errors found!"
  echo "🔧 Fix type errors before pushing"
  echo ""
  exit 1
fi

echo "🔨 Building library..."
npm run build:lib > /dev/null 2>&1
if [ $? -ne 0 ]; then
  echo ""
  echo "❌ Build failed!"
  echo "🔧 Fix build errors before pushing"
  echo ""
  npm run build:lib
  exit 1
fi

echo "✅ Pre-push validation passed! (~5s)"
echo "💡 Full validation (tests, schemas) will run in GitHub Actions CI"
`;

function installHooks() {
  // Handle both regular git repos and git worktrees
  let gitDir = path.join(process.cwd(), '.git');

  // Check if .git exists
  if (!fs.existsSync(gitDir)) {
    log('❌ Not a git repository', 'red');
    process.exit(1);
  }

  // If .git is a file (worktree), read the actual git directory
  if (fs.statSync(gitDir).isFile()) {
    const gitContent = fs.readFileSync(gitDir, 'utf8').trim();
    if (gitContent.startsWith('gitdir: ')) {
      gitDir = gitContent.replace('gitdir: ', '');
      if (!path.isAbsolute(gitDir)) {
        gitDir = path.resolve(process.cwd(), gitDir);
      }
    }
  }

  const hooksDir = path.join(gitDir, 'hooks');
  const prePushPath = path.join(hooksDir, 'pre-push');
  const commitMsgPath = path.join(hooksDir, 'commit-msg');

  // Create hooks directory if it doesn't exist
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  let installed = 0;

  // Install commit-msg hook
  if (fs.existsSync(commitMsgPath)) {
    const existingContent = fs.readFileSync(commitMsgPath, 'utf8');
    if (!existingContent.includes('commitlint')) {
      fs.writeFileSync(commitMsgPath, commitMsgHook);
      fs.chmodSync(commitMsgPath, 0o755);
      installed++;
    }
  } else {
    fs.writeFileSync(commitMsgPath, commitMsgHook);
    fs.chmodSync(commitMsgPath, 0o755);
    installed++;
  }

  // Install pre-push hook
  if (fs.existsSync(prePushPath)) {
    const existingContent = fs.readFileSync(prePushPath, 'utf8');
    // Update if it's the old slow version or doesn't have our fast hook
    if (existingContent.includes('npm run ci:pre-push') || !existingContent.includes('Fast validation')) {
      fs.writeFileSync(prePushPath, prePushHook);
      fs.chmodSync(prePushPath, 0o755);
      installed++;
      log('  ✨ Updated pre-push hook to fast version', 'green');
    }
  } else {
    fs.writeFileSync(prePushPath, prePushHook);
    fs.chmodSync(prePushPath, 0o755);
    installed++;
  }

  if (installed === 0) {
    log('✅ Git hooks are already configured', 'green');
    return;
  }

  log(`✅ Installed ${installed} git hook(s) successfully!`, 'green');
  log('', 'reset');
  log('🪝 Installed hooks:', 'blue');
  log('  • commit-msg - Validates commit message format (conventional commits)', 'reset');
  log('  • pre-push   - Fast validation: typecheck + build (~5s)', 'reset');
  log('', 'reset');
  log('⚡ What changed: Pre-push now runs FAST checks only (~5s)', 'green');
  log('   Full tests, schema validation run in GitHub Actions CI', 'reset');
  log('', 'reset');
  log('💡 What this prevents:', 'blue');
  log('  • Commit messages that fail CI commitlint checks', 'reset');
  log('  • Pushing code with TypeScript errors or build failures', 'reset');
  log('  • Note: Tests/schemas validated in CI (too slow for local)', 'reset');
}

// CLI execution
if (require.main === module) {
  installHooks();
}

module.exports = { installHooks };
