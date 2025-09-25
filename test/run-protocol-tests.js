#!/usr/bin/env node

/**
 * Protocol Test Runner - Executes protocol compliance and validation tests
 * 
 * This script runs the protocol testing suite and provides detailed reporting
 * on protocol compliance issues.
 */

const { spawn } = require('child_process');
const path = require('path');

// Colors for console output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logHeader(message) {
  log(`\n${'='.repeat(60)}`, colors.blue);
  log(`  ${message}`, colors.blue);
  log(`${'='.repeat(60)}`, colors.blue);
}

function logSection(message) {
  log(`\n${'-'.repeat(40)}`, colors.yellow);
  log(`  ${message}`, colors.yellow);
  log(`${'-'.repeat(40)}`, colors.yellow);
}

async function runTests(testPattern, description) {
  return new Promise((resolve, reject) => {
    const testProcess = spawn('node', ['--test', testPattern], {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: path.join(__dirname, '..')
    });

    let stdout = '';
    let stderr = '';

    testProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    testProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    testProcess.on('close', (code) => {
      const result = {
        code,
        stdout,
        stderr,
        description,
        success: code === 0
      };

      if (result.success) {
        log(`✅ ${description} - PASSED`, colors.green);
      } else {
        log(`❌ ${description} - FAILED`, colors.red);
      }

      resolve(result);
    });

    testProcess.on('error', (error) => {
      reject(error);
    });
  });
}

function parseTestResults(output) {
  const lines = output.split('\n');
  const results = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: 0
  };

  // Parse Node.js test runner output
  lines.forEach(line => {
    if (line.includes('✓')) results.passed++;
    if (line.includes('✗')) results.failed++;
    if (line.includes('tests')) {
      const match = line.match(/(\d+) tests/);
      if (match) results.total = parseInt(match[1]);
    }
    if (line.includes('ms')) {
      const match = line.match(/(\d+(?:\.\d+)?)ms/);
      if (match) results.duration = parseFloat(match[1]);
    }
  });

  return results;
}

function generateReport(testResults) {
  logHeader('PROTOCOL TEST RESULTS SUMMARY');

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalDuration = 0;

  testResults.forEach(result => {
    logSection(result.description);
    
    if (result.success) {
      log('  Status: PASSED', colors.green);
      const parsed = parseTestResults(result.stdout);
      log(`  Tests: ${parsed.passed} passed, ${parsed.failed} failed, ${parsed.total} total`);
      log(`  Duration: ${parsed.duration}ms`);
      
      totalTests += parsed.total;
      totalPassed += parsed.passed;
      totalFailed += parsed.failed;
      totalDuration += parsed.duration;
    } else {
      log('  Status: FAILED', colors.red);
      log('  Error Output:', colors.red);
      console.log(result.stderr);
      totalFailed++;
    }
  });

  logHeader('OVERALL SUMMARY');
  log(`Total Test Suites: ${testResults.length}`);
  log(`Total Tests: ${totalTests}`);
  log(`Passed: ${totalPassed}`, colors.green);
  log(`Failed: ${totalFailed}`, totalFailed > 0 ? colors.red : colors.green);
  log(`Duration: ${totalDuration.toFixed(2)}ms`);

  const successRate = totalTests > 0 ? (totalPassed / totalTests * 100).toFixed(1) : 0;
  log(`Success Rate: ${successRate}%`, successRate === '100.0' ? colors.green : colors.yellow);

  return {
    success: totalFailed === 0,
    totalTests,
    totalPassed,
    totalFailed,
    successRate: parseFloat(successRate)
  };
}

async function main() {
  const startTime = Date.now();
  
  logHeader('ADCP PROTOCOL TESTING SUITE');
  log('Running comprehensive protocol validation tests...\n');

  const testSuites = [
    {
      pattern: 'test/lib/protocol-compliance.test.js',
      description: 'Protocol Compliance Tests'
    },
    {
      pattern: 'test/lib/protocol-schema-validation.test.js', 
      description: 'Schema Validation Tests'
    },
    {
      pattern: 'test/lib/protocol-integration-contract.test.js',
      description: 'Integration Contract Tests'
    }
  ];

  const results = [];

  // Run each test suite
  for (const suite of testSuites) {
    logSection(`Running: ${suite.description}`);
    try {
      const result = await runTests(suite.pattern, suite.description);
      results.push(result);
    } catch (error) {
      log(`❌ Failed to run ${suite.description}: ${error.message}`, colors.red);
      results.push({
        description: suite.description,
        success: false,
        error: error.message
      });
    }
  }

  const summary = generateReport(results);
  
  const totalTime = Date.now() - startTime;
  log(`\nTotal execution time: ${totalTime}ms`);

  // Print recommendations based on results
  if (summary.success) {
    logHeader('🎉 ALL PROTOCOL TESTS PASSED');
    log('Your protocol implementations are compliant with A2A and MCP specifications.', colors.green);
    log('You can confidently deploy without protocol format issues.', colors.green);
  } else {
    logHeader('⚠️  PROTOCOL TEST FAILURES DETECTED');
    log('Please fix the following issues before deploying:', colors.red);
    
    results.forEach(result => {
      if (!result.success) {
        log(`\n• ${result.description}:`, colors.red);
        if (result.error) {
          log(`  Error: ${result.error}`, colors.red);
        } else {
          log('  Check test output above for specific failures', colors.red);
        }
      }
    });
    
    log('\nCommon fixes:', colors.yellow);
    log('• Ensure A2A messages have kind: "message"');
    log('• Use "input" field instead of deprecated "parameters"');
    log('• Validate JSON-RPC 2.0 structure for both A2A and MCP');
    log('• Check authentication header integration');
  }

  // Exit with appropriate code
  process.exit(summary.success ? 0 : 1);
}

// Handle command line arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
ADCP Protocol Test Runner

Usage:
  node test/run-protocol-tests.js [options]

Options:
  --help, -h     Show this help message
  --verbose, -v  Show verbose output
  --only <test>  Run only specific test suite:
                 - compliance
                 - schema  
                 - integration

Examples:
  node test/run-protocol-tests.js
  node test/run-protocol-tests.js --verbose
  node test/run-protocol-tests.js --only compliance
`);
  process.exit(0);
}

// Handle single test suite execution
if (args.includes('--only')) {
  const onlyIndex = args.indexOf('--only');
  const testType = args[onlyIndex + 1];
  
  const testMap = {
    'compliance': 'test/lib/protocol-compliance.test.js',
    'schema': 'test/lib/protocol-schema-validation.test.js',
    'integration': 'test/lib/protocol-integration-contract.test.js'
  };
  
  if (testMap[testType]) {
    logHeader(`Running Only: ${testType.charAt(0).toUpperCase() + testType.slice(1)} Tests`);
    runTests(testMap[testType], `${testType} tests`)
      .then(result => {
        if (result.success) {
          log(`✅ ${testType} tests passed!`, colors.green);
          process.exit(0);
        } else {
          log(`❌ ${testType} tests failed!`, colors.red);
          console.log(result.stderr);
          process.exit(1);
        }
      })
      .catch(error => {
        log(`Error running ${testType} tests: ${error.message}`, colors.red);
        process.exit(1);
      });
  } else {
    log(`Unknown test type: ${testType}`, colors.red);
    log('Available types: compliance, schema, integration', colors.yellow);
    process.exit(1);
  }
} else {
  // Run full test suite
  main().catch(error => {
    log(`Unexpected error: ${error.message}`, colors.red);
    console.error(error);
    process.exit(1);
  });
}