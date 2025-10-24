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
  reset: '\x1b[0m'
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

# Run commitlint
echo "$COMMIT_MSG" | npx commitlint --config commitlint.config.js

if [ $? -ne 0 ]; then
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
# This mirrors GitHub Actions CI checks locally

echo "🔍 Running pre-push validation..."

# Check if schema cache exists
if [ ! -d "schemas/cache/latest" ]; then
  echo "⚠️  Schema cache not found - this is your first push"
  echo "📥 Downloading schemas from AdCP specification..."
  npm run sync-schemas
fi

# Set CI=true to skip slow tests (matches GitHub Actions behavior)
# This skips tests marked with: skip: process.env.CI ? 'reason' : false
# e.g., error-scenarios.test.js which tests complex timeout/race conditions
export CI=true

# Run the comprehensive CI validation (includes schema validation)
npm run ci:pre-push

if [ $? -ne 0 ]; then
  echo ""
  echo "❌ Pre-push validation failed!"
  echo "🔧 Fix the issues above before pushing"
  echo ""
  echo "💡 To run validation manually: CI=true npm run ci:validate"
  echo "💡 Schema issues? Try: npm run sync-schemas && npm run generate-types"
  echo ""
  exit 1
fi

echo "✅ Pre-push validation passed! Proceeding with push..."
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
    if (!existingContent.includes('npm run ci:pre-push')) {
      fs.writeFileSync(prePushPath, prePushHook);
      fs.chmodSync(prePushPath, 0o755);
      installed++;
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
  log('  • pre-push   - Runs schema checks, typecheck, build, and tests', 'reset');
  log('', 'reset');
  log('⚠️  Note: Git hooks may not work in all environments (worktrees, some git clients)', 'yellow');
  log('   CI on GitHub is the source of truth for validation', 'yellow');
  log('', 'reset');
  log('💡 What this prevents:', 'blue');
  log('  • Commit messages that fail CI commitlint checks', 'reset');
  log('  • Pushing code that doesn\'t build or pass tests', 'reset');
  log('  • Schema synchronization issues', 'reset');
}

// CLI execution
if (require.main === module) {
  installHooks();
}

module.exports = { installHooks };