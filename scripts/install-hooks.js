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

// Pre-push hook content
const prePushHook = `#!/bin/bash

# Pre-push hook to validate code before pushing
# This mirrors GitHub Actions CI checks locally

echo "🔍 Running pre-push validation..."

# Run the comprehensive CI validation
npm run ci:pre-push

if [ $? -ne 0 ]; then
  echo ""
  echo "❌ Pre-push validation failed!"
  echo "🔧 Fix the issues above before pushing"
  echo ""
  echo "💡 To skip this hook (not recommended): git push --no-verify"
  echo "💡 To run validation manually: npm run ci:validate"
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

  // Create hooks directory if it doesn't exist
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // Check if pre-push hook already exists
  if (fs.existsSync(prePushPath)) {
    log('⚠️  Pre-push hook already exists', 'yellow');
    const existingContent = fs.readFileSync(prePushPath, 'utf8');
    if (existingContent.includes('npm run ci:pre-push')) {
      log('✅ Pre-push hook is already configured', 'green');
      return;
    } else {
      log('🔄 Updating existing pre-push hook...', 'blue');
    }
  }

  // Write the pre-push hook
  fs.writeFileSync(prePushPath, prePushHook);
  
  // Make it executable
  fs.chmodSync(prePushPath, 0o755);

  log('✅ Pre-push hook installed successfully!', 'green');
  log('', 'reset');
  log('🔧 What happens now:', 'blue');
  log('  • Before each git push, validation will run automatically', 'reset');
  log('  • If validation fails, the push will be blocked', 'reset');
  log('  • Run "npm run ci:validate" to test validation manually', 'reset');
  log('  • Use "git push --no-verify" to skip validation (not recommended)', 'reset');
  log('', 'reset');
  log('💡 Available validation commands:', 'blue');
  log('  • npm run ci:validate     - Full CI validation', 'reset');
  log('  • npm run ci:quick        - Quick checks (typecheck + build + test)', 'reset');
  log('  • npm run ci:schema-check - Schema synchronization check', 'reset');
  log('  • npm run ci:pre-push     - Pre-push validation (schema + quick)', 'reset');
}

// CLI execution
if (require.main === module) {
  installHooks();
}

module.exports = { installHooks };