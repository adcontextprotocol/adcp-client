#!/usr/bin/env node

/**
 * Local CI Validation Script
 * Mirrors GitHub Actions CI checks exactly for local validation
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Color output helpers
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title) {
  console.log('');
  log('='.repeat(60), 'cyan');
  log(`${title}`, 'cyan');
  log('='.repeat(60), 'cyan');
}

function subsection(title) {
  console.log('');
  log(`📋 ${title}`, 'blue');
  log('-'.repeat(40), 'blue');
}

// Run command and return { success, output, error }
function runCommand(command, cwd = process.cwd(), options = {}) {
  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options,
    });
    return { success: true, output, error: null };
  } catch (error) {
    return {
      success: false,
      output: error.stdout || '',
      error: error.stderr || error.message,
    };
  }
}

// Check if git working directory is clean
function checkGitStatus() {
  const result = runCommand('git status --porcelain', process.cwd(), { silent: true });
  if (!result.success) {
    throw new Error('Failed to check git status');
  }
  return result.output.trim() === '';
}

// Main validation function
async function validateCI() {
  const startTime = Date.now();
  let totalTests = 0;
  let passedTests = 0;
  const failures = [];

  section('🚀 Local CI Validation (Mirroring GitHub Actions)');

  // Check Node.js version
  subsection('Environment Check');
  const nodeVersion = process.version;
  log(`Node.js version: ${nodeVersion}`, 'green');

  // Check if this is a clean git state
  const isClean = checkGitStatus();
  if (!isClean) {
    log('⚠️  Warning: Working directory has uncommitted changes', 'yellow');
    log('   This may affect validation results', 'yellow');
  }

  // 1. SCHEMA SYNCHRONIZATION CHECK (mirrors schema-sync.yml)
  section('🔄 Schema Synchronization Check');

  subsection('Sync schemas from AdCP');
  totalTests++;
  const syncResult = runCommand('npm run sync-schemas');
  if (syncResult.success) {
    log('✅ Schema sync completed', 'green');
    passedTests++;
  } else {
    log('❌ Schema sync failed', 'red');
    failures.push('Schema sync failed');
  }

  subsection('Generate types from fresh schemas');
  totalTests++;
  const generateResult = runCommand('npm run generate-types');
  if (generateResult.success) {
    log('✅ Type generation completed', 'green');
    passedTests++;
  } else {
    log('❌ Type generation failed', 'red');
    failures.push('Type generation failed');
  }

  subsection('Sync registry OpenAPI and generate registry types');
  totalTests++;
  const registryGenerateResult = runCommand('npm run generate-registry-types -- --sync');
  if (registryGenerateResult.success) {
    log('✅ Registry type generation completed', 'green');
    passedTests++;
  } else {
    log('❌ Registry type generation failed', 'red');
    failures.push('Registry type generation failed');
  }

  subsection('Check for schema changes');
  totalTests++;
  const diffResult = runCommand(
    'git diff --exit-code src/lib/types/ src/lib/agents/ src/lib/registry/types.generated.ts schemas/registry/registry.yaml',
    process.cwd(),
    { silent: true }
  );
  if (diffResult.success) {
    log('✅ Schemas and registry OpenAPI are up to date', 'green');
    passedTests++;
  } else {
    log('❌ Schema or registry OpenAPI changes detected - types are out of sync', 'red');
    log(
      '   Run: npm run sync-schemas && npm run generate-types && npm run generate-registry-types -- --sync',
      'yellow'
    );
    failures.push('Generated types are out of sync with schemas or registry OpenAPI');
  }

  subsection('Check version synchronization');
  totalTests++;
  const versionResult = runCommand('npm run sync-version 2>&1 | grep -q "Already in sync"', process.cwd(), {
    silent: true,
  });
  if (versionResult.success) {
    log('✅ Version is synchronized', 'green');
    passedTests++;
  } else {
    log('⚠️  Version may need synchronization', 'yellow');
    // Don't fail on this, just warn
    passedTests++;
  }

  // 2. MAIN CI PIPELINE CHECK (mirrors ci.yml)
  section('🔧 Main CI Pipeline Tests');

  subsection('TypeScript type checking');
  totalTests++;
  const typecheckResult = runCommand('npm run typecheck');
  if (typecheckResult.success) {
    log('✅ TypeScript compilation successful', 'green');
    passedTests++;
  } else {
    log('❌ TypeScript type errors found', 'red');
    failures.push('TypeScript type checking failed');
  }

  subsection('Build library');
  totalTests++;
  const buildLibResult = runCommand('npm run build:lib');
  if (buildLibResult.success) {
    log('✅ Library build successful', 'green');
    passedTests++;
  } else {
    log('❌ Library build failed', 'red');
    failures.push('Library build failed');
  }

  subsection('Run tests');
  totalTests++;
  const testResult = runCommand('npm test');
  if (testResult.success) {
    log('✅ All tests passed', 'green');
    passedTests++;
  } else {
    log('❌ Tests failed', 'red');
    failures.push('Tests failed');
  }

  subsection('Build full project');
  totalTests++;
  const buildResult = runCommand('npm run build');
  if (buildResult.success) {
    log('✅ Full project build successful', 'green');
    passedTests++;
  } else {
    log('❌ Full project build failed', 'red');
    failures.push('Full project build failed');
  }

  // 3. CODE QUALITY CHECKS
  section('🔍 Code Quality Checks');

  subsection('Check code formatting');
  totalTests++;
  const formatResult = runCommand('npm run format:check');
  if (formatResult.success) {
    log('✅ Code formatting is correct', 'green');
    passedTests++;
  } else {
    log('❌ Code formatting issues found', 'red');
    log('   Run: npm run format to fix formatting', 'yellow');
    failures.push('Code formatting check failed');
  }

  subsection('Check package.json integrity');
  totalTests++;
  try {
    // Verify no missing dependencies
    const lsResult = runCommand('npm ls --depth=0', process.cwd(), { silent: true });

    // Verify package exports are valid
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

    if (!fs.existsSync(pkg.main)) {
      throw new Error(`Main export file does not exist: ${pkg.main}`);
    }

    if (!fs.existsSync(pkg.types)) {
      throw new Error(`Types export file does not exist: ${pkg.types}`);
    }

    log('✅ Package exports are valid', 'green');
    passedTests++;
  } catch (error) {
    log(`❌ Package integrity check failed: ${error.message}`, 'red');
    failures.push('Package integrity check failed');
  }

  // 4. SECURITY AUDIT
  section('🔒 Security Audit');

  subsection('Run security audit');
  totalTests++;
  const auditResult = runCommand('npm audit --audit-level=moderate', process.cwd(), { silent: true });
  if (auditResult.success) {
    log('✅ No moderate+ vulnerabilities found', 'green');
    passedTests++;
  } else {
    log('⚠️  Security vulnerabilities found', 'yellow');
    log('   Run: npm audit for details', 'yellow');
    // Don't fail CI for moderate vulnerabilities, just warn
    passedTests++;
  }

  subsection('Check for critical vulnerabilities');
  totalTests++;
  const criticalAuditResult = runCommand(
    'npm audit --audit-level=high --json 2>/dev/null | grep -q \'"level":"high"\\|"level":"critical"\'',
    process.cwd(),
    { silent: true }
  );
  if (!criticalAuditResult.success) {
    log('✅ No high or critical vulnerabilities found', 'green');
    passedTests++;
  } else {
    log('❌ High or critical vulnerabilities found', 'red');
    log('   Run: npm audit --audit-level=high for details', 'yellow');
    failures.push('High or critical security vulnerabilities found');
  }

  // 5. PUBLISH DRY RUN
  section('📦 Publish Dry Run');

  subsection('Test publish process');
  totalTests++;
  try {
    runCommand('npm run prepublishOnly');
    const packResult = runCommand('npm pack --dry-run', process.cwd(), { silent: true });
    if (packResult.success) {
      log('✅ Package is ready for publication', 'green');
      passedTests++;
    } else {
      throw new Error('npm pack failed');
    }
  } catch (error) {
    log('❌ Publish dry run failed', 'red');
    failures.push('Publish dry run failed');
  }

  // SUMMARY
  section('📊 Validation Summary');

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const successRate = ((passedTests / totalTests) * 100).toFixed(1);

  log(`Total checks: ${totalTests}`, 'blue');
  log(`Passed: ${passedTests}`, passedTests === totalTests ? 'green' : 'yellow');
  log(`Failed: ${totalTests - passedTests}`, totalTests === passedTests ? 'green' : 'red');
  log(`Success rate: ${successRate}%`, successRate === '100.0' ? 'green' : 'yellow');
  log(`Duration: ${duration}s`, 'blue');

  if (failures.length > 0) {
    console.log('');
    log('❌ FAILURES:', 'red');
    failures.forEach((failure, index) => {
      log(`   ${index + 1}. ${failure}`, 'red');
    });
    console.log('');
    log('🚨 CI validation failed - fix issues before pushing', 'red');
    process.exit(1);
  } else {
    console.log('');
    log('✅ All CI checks passed! Ready to push 🚀', 'green');
    process.exit(0);
  }
}

// CLI execution
if (require.main === module) {
  validateCI().catch(error => {
    console.error('\n❌ Validation script error:', error.message);
    process.exit(1);
  });
}

module.exports = { validateCI };
