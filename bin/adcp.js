#!/usr/bin/env node

/**
 * AdCP CLI Tool
 *
 * Simple command-line utility to call AdCP agents directly
 *
 * Usage:
 *   adcp <protocol> <agent-url> <tool-name> [payload-json] [--auth token]
 *
 * Examples:
 *   adcp mcp https://agent.example.com/mcp get_products '{"brief":"coffee brands"}'
 *   adcp a2a https://agent.example.com list_creative_formats '{}' --auth your_token_here
 *   adcp mcp https://agent.example.com/mcp create_media_buy @payload.json --auth $AGENT_TOKEN
 */

const { AdCPClient, detectProtocol, usesDeprecatedAssetsField } = require('../dist/lib/index.js');
const { readFileSync, statSync } = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { AsyncWebhookHandler } = require('./adcp-async-handler.js');
const {
  getAgent,
  listAgents,
  isAlias,
  interactiveSetup,
  removeAgent,
  getConfigPath,
  saveAgent,
} = require('./adcp-config.js');
const { handleRegistryCommand } = require('./adcp-registry.js');
const { captureStdoutLogs, writeJsonOutput } = require('./adcp-json-stdout.js');
const {
  createCLIOAuthProvider,
  hasValidOAuthTokens,
  clearOAuthTokens,
  getEffectiveAuthToken,
  createFileOAuthStorage,
  bindAgentStorage,
  NeedsAuthorizationError,
} = require('../dist/lib/auth/oauth/index.js');

// Test scenarios available
const TEST_SCENARIOS = [
  'health_check',
  'discovery',
  'create_media_buy',
  'full_sales_flow',
  'creative_sync',
  'creative_inline',
  'creative_flow',
  'signals_flow',
  'error_handling',
  'validation',
  'pricing_edge_cases',
  'temporal_validation',
  'behavior_analysis',
  'response_consistency',
  // v3 protocol scenarios
  'capability_discovery',
  'governance_property_lists',
  'governance_content_standards',
  'si_session_lifecycle',
  'si_availability',
  'campaign_governance',
  'campaign_governance_denied',
  'campaign_governance_conditions',
  'campaign_governance_delivery',
  'seller_governance_context',
];

// Built-in test agent aliases (shared between main CLI and test command)
// Note: These tokens are intentionally public for the AdCP test infrastructure.
// They provide rate-limited access to test agents for SDK development and examples.
const BUILT_IN_AGENTS = {
  'test-mcp': {
    url: 'https://test-agent.adcontextprotocol.org/mcp/',
    protocol: 'mcp',
    auth_token: '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ',
    description: 'AdCP public test agent (MCP, with auth)',
  },
  'test-a2a': {
    url: 'https://test-agent.adcontextprotocol.org',
    protocol: 'a2a',
    auth_token: '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ',
    description: 'AdCP public test agent (A2A, with auth)',
  },
  'test-no-auth': {
    url: 'https://test-agent.adcontextprotocol.org/mcp/',
    protocol: 'mcp',
    description: 'AdCP public test agent (MCP, no auth - demonstrates errors)',
  },
  'test-a2a-no-auth': {
    url: 'https://test-agent.adcontextprotocol.org',
    protocol: 'a2a',
    description: 'AdCP public test agent (A2A, no auth - demonstrates errors)',
  },
  creative: {
    url: 'https://creative.adcontextprotocol.org/mcp',
    protocol: 'mcp',
    description: 'Official AdCP creative agent (MCP only)',
  },
};

/**
 * Check formats for deprecated assets_required usage
 * Returns array of format IDs using the deprecated field
 */
function checkDeprecatedFormats(formats) {
  if (!formats || !Array.isArray(formats)) return [];

  return formats
    .filter(format => usesDeprecatedAssetsField(format))
    .map(format => format.format_id?.id || format.format_id || format.id || format.name || 'unknown');
}

/**
 * Extract human-readable protocol message from conversation
 */
function extractProtocolMessage(conversation, protocol) {
  if (!conversation || conversation.length === 0) return null;

  // Find the last agent response (don't mutate original array)
  const agentResponse = [...conversation].reverse().find(msg => msg.role === 'agent');
  if (!agentResponse || !agentResponse.content) return null;

  if (protocol === 'mcp') {
    // MCP: The content[].text contains the tool response (JSON stringified)
    // This IS the protocol message in MCP
    if (agentResponse.content.content && Array.isArray(agentResponse.content.content)) {
      const textContent = agentResponse.content.content.find(c => c.type === 'text');
      return textContent?.text || null;
    }
    if (agentResponse.content.text) {
      return agentResponse.content.text;
    }
  } else if (protocol === 'a2a') {
    // A2A: Extract human-readable message from task result
    // The message is nested in result.artifacts[0].parts[0].data.message
    const result = agentResponse.content.result;
    if (result && result.artifacts && result.artifacts.length > 0) {
      const artifact = result.artifacts[0];
      if (artifact.parts && artifact.parts.length > 0) {
        const data = artifact.parts[0].data;
        if (data && data.message) {
          return data.message;
        }
      }
    }
    // Fallback: check top-level status message
    if (result && result.status && result.status.message) {
      return result.status.message;
    }
  }

  return null;
}

/**
 * Display agent info - includes capabilities detection for v3.0
 */
async function displayAgentInfo(agentConfig, jsonOutput) {
  const client = new AdCPClient([agentConfig]);
  const agentClient = client.agent(agentConfig.id);
  const info = await agentClient.getAgentInfo();

  // Try to get capabilities (v3.0 feature detection)
  let capabilities = null;
  try {
    if (typeof agentClient.getCapabilities === 'function') {
      capabilities = await agentClient.getCapabilities();
    }
  } catch (e) {
    // Capabilities detection failed - continue without
  }

  if (jsonOutput) {
    // Include capabilities in JSON output
    const output = {
      ...info,
      ...(capabilities && { capabilities }),
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\n📋 Agent Information\n`);
    console.log(`Name: ${info.name}`);
    if (info.description) {
      console.log(`Description: ${info.description}`);
    }
    console.log(`Protocol: ${info.protocol.toUpperCase()}`);
    console.log(`URL: ${info.url}`);

    // Display capabilities if available
    if (capabilities) {
      console.log(`\n🔧 Capabilities:\n`);
      console.log(`   AdCP Version: ${capabilities.version}${capabilities._synthetic ? ' (detected)' : ''}`);
      if (capabilities.protocols && capabilities.protocols.length > 0) {
        console.log(`   Supported Protocols: ${capabilities.protocols.join(', ')}`);
      }
      if (capabilities.features) {
        const features = [];
        if (capabilities.features.supportsCreativeAssignments) features.push('creative_assignments');
        if (capabilities.features.supportsRenders) features.push('renders');
        if (capabilities.features.supportsPropertyListFiltering) features.push('property_list_filtering');
        if (capabilities.features.supportsContentStandards) features.push('content_standards');
        if (features.length > 0) {
          console.log(`   v3.0 Features: ${features.join(', ')}`);
        }
      }
      if (capabilities.extensions && capabilities.extensions.length > 0) {
        console.log(`   Extensions: ${capabilities.extensions.join(', ')}`);
      }
    }

    console.log(`\nAvailable Tools (${info.tools.length}):\n`);

    if (info.tools.length === 0) {
      console.log('No tools found.');
    } else {
      info.tools.forEach((tool, i) => {
        console.log(`${i + 1}. ${tool.name}`);
        if (tool.description) {
          console.log(`   ${tool.description}`);
        }
        if (tool.parameters && tool.parameters.length > 0) {
          console.log(`   Parameters: ${tool.parameters.join(', ')}`);
        }
        console.log('');
      });
    }
  }
}

/**
 * Handle the 'test' subcommand for running agent test scenarios
 */
async function handleTestCommand(args) {
  // Handle --list-scenarios and --help
  if (args.includes('--list-scenarios') || args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log('\n📋 Available Test Scenarios:\n');
    const descriptions = {
      health_check: 'Basic connectivity check - verify agent responds',
      discovery: 'Test get_products, list_creative_formats, list_authorized_properties',
      create_media_buy: 'Discovery + create a test media buy (sandbox)',
      full_sales_flow: 'Full lifecycle: discovery → create → update → delivery',
      creative_sync: 'Test sync_creatives flow',
      creative_inline: 'Test inline creatives in create_media_buy',
      creative_flow: 'Creative agent: list_formats → build → preview',
      signals_flow: 'Signals agent: get_signals → activate',
      error_handling: 'Verify agent returns proper error responses',
      validation: 'Test schema validation (invalid inputs should be rejected)',
      pricing_edge_cases: 'Test auction vs fixed pricing, min spend, bid_price',
      temporal_validation: 'Test date/time ordering and format validation',
      behavior_analysis: 'Analyze agent behavior: auth, brief relevance, filtering',
      response_consistency: 'Check for schema errors, pagination bugs, data mismatches',
      // v3 protocol scenarios
      capability_discovery: 'Test get_adcp_capabilities and verify v3 protocol support',
      governance_property_lists: 'Test property list CRUD (create, get, update, delete)',
      governance_content_standards: 'Test content standards listing and calibration',
      si_session_lifecycle: 'Test full SI session: initiate → messages → terminate',
      si_availability: 'Quick check for SI offering availability',
      campaign_governance: 'Full governance lifecycle: sync_plans → check → execute → report',
      campaign_governance_denied: 'Denied flow: over-budget, unauthorized market',
      campaign_governance_conditions: 'Conditions flow: apply conditions → re-check',
      campaign_governance_delivery: 'Delivery monitoring with drift detection',
      seller_governance_context: 'Verify seller persists governance_context from media buy lifecycle',
    };

    for (const scenario of TEST_SCENARIOS) {
      console.log(`  ${scenario}`);
      if (descriptions[scenario]) {
        console.log(`    ${descriptions[scenario]}`);
      }
      console.log('');
    }
    console.log('Usage: adcp test <agent> [scenario] [options]\n');
    return;
  }

  // Parse options with bounds checking
  const authIndex = args.indexOf('--auth');
  let authToken = process.env.ADCP_AUTH_TOKEN;
  if (authIndex !== -1) {
    if (authIndex + 1 >= args.length || args[authIndex + 1].startsWith('--')) {
      console.error('ERROR: --auth requires a token value\n');
      process.exit(2);
    }
    authToken = args[authIndex + 1];
  }

  const protocolIndex = args.indexOf('--protocol');
  let protocolFlag = null;
  if (protocolIndex !== -1) {
    if (protocolIndex + 1 >= args.length || args[protocolIndex + 1].startsWith('--')) {
      console.error('ERROR: --protocol requires a value (mcp or a2a)\n');
      process.exit(2);
    }
    protocolFlag = args[protocolIndex + 1];
  }

  const briefIndex = args.indexOf('--brief');
  let brief;
  if (briefIndex !== -1) {
    if (briefIndex + 1 >= args.length || args[briefIndex + 1].startsWith('--')) {
      console.error('ERROR: --brief requires a value\n');
      process.exit(2);
    }
    brief = args[briefIndex + 1];
  }

  const jsonOutput = args.includes('--json');
  const debug = args.includes('--debug') || process.env.ADCP_DEBUG === 'true';
  const dryRun = args.includes('--dry-run');
  const useOAuth = args.includes('--oauth');

  // Filter out flag arguments to find positional arguments
  const positionalArgs = args.filter(
    arg => !arg.startsWith('--') && arg !== authToken && arg !== protocolFlag && arg !== brief
  );

  if (positionalArgs.length === 0) {
    console.error('ERROR: test command requires an agent alias or URL\n');
    console.error('Usage: adcp test <agent> [scenario] [options]');
    console.error('       adcp test --list-scenarios\n');
    process.exit(2);
  }

  const agentArg = positionalArgs[0];
  const scenario = positionalArgs[1] || 'discovery';

  // Validate scenario
  if (!TEST_SCENARIOS.includes(scenario)) {
    console.error(`ERROR: Unknown scenario '${scenario}'\n`);
    console.error('Available scenarios:');
    TEST_SCENARIOS.forEach(s => console.error(`  - ${s}`));
    console.error('\nUse: adcp test --list-scenarios for descriptions\n');
    process.exit(2);
  }

  // Validate protocol flag if provided
  if (protocolFlag && protocolFlag !== 'mcp' && protocolFlag !== 'a2a') {
    console.error(`ERROR: Invalid protocol '${protocolFlag}'. Must be 'mcp' or 'a2a'\n`);
    process.exit(2);
  }

  let agentUrl;
  let protocol = protocolFlag;
  let finalAuthToken = authToken;
  let oauthTokens = null;

  // Resolve agent
  if (BUILT_IN_AGENTS[agentArg]) {
    const builtIn = BUILT_IN_AGENTS[agentArg];
    agentUrl = builtIn.url;
    protocol = protocol || builtIn.protocol;
    finalAuthToken = finalAuthToken || builtIn.auth_token;
  } else if (isAlias(agentArg)) {
    const savedAgent = getAgent(agentArg);
    agentUrl = savedAgent.url;
    protocol = protocol || savedAgent.protocol;
    finalAuthToken = finalAuthToken || getEffectiveAuthToken(savedAgent);
    if (savedAgent.oauth_tokens) {
      if (hasValidOAuthTokens(savedAgent)) {
        oauthTokens = savedAgent.oauth_tokens;
      } else {
        if (debug) {
          console.error(
            `DEBUG: OAuth tokens expired for '${agentArg}', using ${finalAuthToken ? 'static token' : 'no auth'}`
          );
        }
        if (useOAuth) {
          // Only error on expired tokens if --oauth flag was explicitly passed
          if (jsonOutput) {
            console.log(
              JSON.stringify({
                success: false,
                error: 'OAuth tokens expired',
                message: `Run: adcp ${agentArg} --oauth to refresh`,
              })
            );
          } else {
            console.error(`⚠️  OAuth tokens for '${agentArg}' are expired.`);
            console.error(`Run: adcp ${agentArg} --oauth to refresh.\n`);
          }
          process.exit(2);
        }
      }
    }
  } else if (agentArg.startsWith('http://') || agentArg.startsWith('https://')) {
    agentUrl = agentArg;
    if (useOAuth && !jsonOutput) {
      console.error('⚠️  --oauth flag only works with saved agent aliases, not URLs.');
      console.error('   Save the agent first: adcp --save-auth <alias> <url> --oauth\n');
    }
  } else {
    console.error(`ERROR: '${agentArg}' is not a valid agent alias or URL\n`);
    console.error('Built-in aliases: test-mcp, test-a2a, creative');
    console.error(`Saved aliases: ${Object.keys(listAgents()).join(', ') || 'none'}\n`);
    process.exit(2);
  }

  // Auto-detect protocol if not specified
  if (!protocol) {
    if (!jsonOutput) {
      console.error('🔍 Auto-detecting protocol...');
    }
    try {
      protocol = await detectProtocol(agentUrl);
      if (!jsonOutput) {
        console.error(`✓ Detected protocol: ${protocol.toUpperCase()}\n`);
      }
    } catch (error) {
      console.error(`ERROR: Failed to detect protocol: ${error.message}\n`);
      console.error('Please specify protocol: --protocol mcp or --protocol a2a\n');
      process.exit(2);
    }
  }

  // Build test options
  const testOptions = {
    protocol,
    brief,
    ...(finalAuthToken && { auth: { type: 'bearer', token: finalAuthToken } }),
  };

  if (!jsonOutput) {
    console.log(`\n🧪 Running '${scenario}' tests against ${agentUrl}`);
    console.log(`   Protocol: ${protocol.toUpperCase()}`);
    console.log(`   Auth: ${oauthTokens ? 'oauth' : finalAuthToken ? 'configured' : 'none'}\n`);
  }

  // Import and run tests
  try {
    const {
      testAgent: runAgentTests,
      formatTestResults,
      formatTestResultsJSON,
    } = await import('../dist/lib/testing/agent-tester.js');

    // Silence default logger for cleaner output
    const { setAgentTesterLogger } = await import('../dist/lib/testing/client.js');
    if (!debug) {
      setAgentTesterLogger({
        info: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
      });
    }

    const result = await runAgentTests(agentUrl, scenario, testOptions);

    if (jsonOutput) {
      console.log(formatTestResultsJSON(result));
    } else {
      console.log(formatTestResults(result));
    }

    // Clean up cached connections before exit
    const { closeMCPConnections } = await import('../dist/lib/protocols/mcp.js');
    await closeMCPConnections();

    // Exit with appropriate code
    process.exit(result.overall_passed ? 0 : 3);
  } catch (error) {
    // Clean up cached connections before exit
    try {
      const { closeMCPConnections } = await import('../dist/lib/protocols/mcp.js');
      await closeMCPConnections();
    } catch {
      /* ignore */
    }

    console.error(`\n❌ Test execution failed: ${error.message}`);
    if (debug) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Parse a JSON flag value — supports inline JSON or @file.json (read from file).
 */
function parseJsonFlag(flagName, value) {
  if (value.startsWith('@')) {
    const filePath = value.substring(1);
    if (!filePath) {
      console.error(`${flagName} requires a filename after @, e.g. ${flagName} @context.json`);
      process.exit(2);
    }
    let fileContent;
    try {
      fileContent = readFileSync(filePath, 'utf-8');
    } catch (e) {
      console.error(`Cannot read file for ${flagName}: ${e.message}`);
      process.exit(2);
    }
    try {
      return JSON.parse(fileContent);
    } catch (e) {
      console.error(`Invalid JSON in ${filePath} for ${flagName}: ${e.message}`);
      process.exit(2);
    }
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    console.error(`Invalid JSON for ${flagName}: ${e.message}`);
    process.exit(2);
  }
}

function closestFlag(input, known) {
  let best = null;
  let bestDist = Infinity;
  for (const flag of known) {
    const d = levenshtein(input, flag);
    if (d < bestDist) {
      bestDist = d;
      best = flag;
    }
  }
  // Only suggest if the edit distance is reasonable (at most ~30% of the flag length)
  return bestDist <= Math.max(2, Math.ceil(input.length * 0.3)) ? best : null;
}

function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function parseAgentOptions(args) {
  const authIndex = args.indexOf('--auth');
  let authToken = process.env.ADCP_AUTH_TOKEN;
  if (authIndex !== -1 && authIndex + 1 < args.length && !args[authIndex + 1].startsWith('--')) {
    authToken = args[authIndex + 1];
  }

  const protocolIndex = args.indexOf('--protocol');
  let protocolFlag = null;
  if (protocolIndex !== -1 && protocolIndex + 1 < args.length && !args[protocolIndex + 1].startsWith('--')) {
    protocolFlag = args[protocolIndex + 1];
  }

  const briefIndex = args.indexOf('--brief');
  let brief;
  if (briefIndex !== -1 && briefIndex + 1 < args.length && !args[briefIndex + 1].startsWith('--')) {
    brief = args[briefIndex + 1];
  }

  // Storyboard-specific flags (--context, --request) with JSON values
  const contextIndex = args.indexOf('--context');
  let contextValue = null;
  if (contextIndex !== -1 && contextIndex + 1 < args.length && !args[contextIndex + 1].startsWith('--')) {
    contextValue = args[contextIndex + 1];
  }

  const requestIndex = args.indexOf('--request');
  let requestValue = null;
  if (requestIndex !== -1 && requestIndex + 1 < args.length && !args[requestIndex + 1].startsWith('--')) {
    requestValue = args[requestIndex + 1];
  }

  // Assessment flags (--tracks, --storyboards, --platform-type, --timeout)
  const tracksIndex = args.indexOf('--tracks');
  let tracksValue = null;
  if (tracksIndex !== -1 && tracksIndex + 1 < args.length && !args[tracksIndex + 1].startsWith('--')) {
    tracksValue = args[tracksIndex + 1];
  }

  const storyboardsIndex = args.indexOf('--storyboards');
  let storyboardsValue = null;
  if (storyboardsIndex !== -1 && storyboardsIndex + 1 < args.length && !args[storyboardsIndex + 1].startsWith('--')) {
    storyboardsValue = args[storyboardsIndex + 1];
  }

  const platformTypeIndex = args.indexOf('--platform-type');
  let platformTypeValue = null;
  if (
    platformTypeIndex !== -1 &&
    platformTypeIndex + 1 < args.length &&
    !args[platformTypeIndex + 1].startsWith('--')
  ) {
    platformTypeValue = args[platformTypeIndex + 1];
  }

  const timeoutIndex = args.indexOf('--timeout');
  let timeoutValue = null;
  if (timeoutIndex !== -1 && timeoutIndex + 1 < args.length && !args[timeoutIndex + 1].startsWith('--')) {
    timeoutValue = args[timeoutIndex + 1];
  }

  // --multi-instance-strategy's value is captured here solely so it's excluded
  // from `positionalArgs`. The authoritative parse lives in
  // `extractMultiInstanceStrategy(args)` which validates the value and emits
  // error messages; keeping both in sync requires adding the string here when
  // the enum grows.
  const multiInstanceStrategyIndex = args.indexOf('--multi-instance-strategy');
  const multiInstanceStrategyValue =
    multiInstanceStrategyIndex !== -1 &&
    multiInstanceStrategyIndex + 1 < args.length &&
    !args[multiInstanceStrategyIndex + 1].startsWith('--')
      ? args[multiInstanceStrategyIndex + 1]
      : null;

  // --file PATH | --file=PATH: ad-hoc storyboard YAML (spec evolution workflow)
  const fileIndex = args.indexOf('--file');
  let file = null;
  if (fileIndex !== -1 && fileIndex + 1 < args.length && !args[fileIndex + 1].startsWith('--')) {
    file = args[fileIndex + 1];
  } else {
    const eqArg = args.find(a => a.startsWith('--file='));
    if (eqArg) file = eqArg.slice('--file='.length);
  }

  const jsonOutput = args.includes('--json');
  const debug = args.includes('--debug') || process.env.ADCP_DEBUG === 'true';
  const dryRun = args.includes('--dry-run');
  const allowHttp = args.includes('--allow-http');

  // Webhook-receiver flags are captured here solely so their values are excluded
  // from `positionalArgs`. The authoritative parse lives in
  // `extractWebhookReceiverOptions(args)` which validates and exits on error.
  const webhookReceiverIdx = args.indexOf('--webhook-receiver');
  const webhookReceiverModeValue =
    webhookReceiverIdx !== -1 && webhookReceiverIdx + 1 < args.length && !args[webhookReceiverIdx + 1].startsWith('--')
      ? args[webhookReceiverIdx + 1]
      : null;
  const webhookReceiverPortIdx = args.indexOf('--webhook-receiver-port');
  const webhookReceiverPortValue =
    webhookReceiverPortIdx !== -1 &&
    webhookReceiverPortIdx + 1 < args.length &&
    !args[webhookReceiverPortIdx + 1].startsWith('--')
      ? args[webhookReceiverPortIdx + 1]
      : null;
  const webhookReceiverPublicUrlIdx = args.indexOf('--webhook-receiver-public-url');
  const webhookReceiverPublicUrlValue =
    webhookReceiverPublicUrlIdx !== -1 &&
    webhookReceiverPublicUrlIdx + 1 < args.length &&
    !args[webhookReceiverPublicUrlIdx + 1].startsWith('--')
      ? args[webhookReceiverPublicUrlIdx + 1]
      : null;

  // Filter out flags and their values to find positional args. The `--file=PATH`
  // form is already removed by the `startsWith('--')` check; only the
  // space-separated value needs explicit exclusion. Use explicit nullish check
  // so falsy-but-valid values (e.g. port "0") aren't dropped from the filter.
  const flagValues = [
    authToken,
    protocolFlag,
    brief,
    contextValue,
    requestValue,
    tracksValue,
    storyboardsValue,
    platformTypeValue,
    timeoutValue,
    multiInstanceStrategyValue,
    webhookReceiverModeValue,
    webhookReceiverPortValue,
    webhookReceiverPublicUrlValue,
    fileIndex !== -1 ? file : null,
  ].filter(v => v !== null && v !== undefined);
  const positionalArgs = args.filter(arg => !arg.startsWith('--') && !flagValues.includes(arg));

  return { authToken, protocolFlag, brief, file, jsonOutput, debug, dryRun, allowHttp, positionalArgs };
}

/**
 * Resolve an agent argument (alias or URL) to { agentUrl, protocol, authToken, oauthTokens, oauthClient, aliasId }
 *
 * Auth resolution order:
 *   1. Explicit --auth token from CLI (bearer)
 *   2. ADCP_AUTH_TOKEN env var
 *   3. Saved OAuth tokens (if alias has them — returned as-is so the caller can refresh on 401)
 *   4. Static auth_token from alias or built-in
 *   5. None
 */
async function resolveAgent(agentArg, authToken, protocolFlag, jsonOutput) {
  let agentUrl;
  let protocol = protocolFlag;
  let finalAuthToken = authToken;
  let oauthTokens;
  let oauthClient;
  let aliasId;

  if (BUILT_IN_AGENTS[agentArg]) {
    const builtIn = BUILT_IN_AGENTS[agentArg];
    agentUrl = builtIn.url;
    protocol = protocol || builtIn.protocol;
    finalAuthToken = finalAuthToken || builtIn.auth_token;
  } else if (isAlias(agentArg)) {
    const savedAgent = getAgent(agentArg);
    agentUrl = savedAgent.url;
    protocol = protocol || savedAgent.protocol;
    aliasId = agentArg;
    // Return saved OAuth tokens even when they look stale — the MCP SDK's
    // OAuth provider will refresh them on demand. Only fall back to the
    // static `auth_token` when there's no OAuth material at all.
    if (savedAgent.oauth_tokens) {
      oauthTokens = savedAgent.oauth_tokens;
      oauthClient = savedAgent.oauth_client;
    }
    finalAuthToken = finalAuthToken || getEffectiveAuthToken(savedAgent);
  } else if (agentArg.startsWith('http://') || agentArg.startsWith('https://')) {
    agentUrl = agentArg;
  } else {
    console.error(`ERROR: '${agentArg}' is not a valid agent alias or URL\n`);
    console.error('Built-in aliases: test-mcp, test-a2a, creative');
    console.error(`Saved aliases: ${Object.keys(listAgents()).join(', ') || 'none'}\n`);
    process.exit(2);
  }

  // Auto-detect protocol if not specified
  if (!protocol) {
    if (!jsonOutput) console.error('Auto-detecting protocol...');
    try {
      protocol = await detectProtocol(agentUrl);
      if (!jsonOutput) console.error(`Detected protocol: ${protocol.toUpperCase()}\n`);
    } catch (error) {
      console.error(`ERROR: Failed to detect protocol: ${error.message}\n`);
      process.exit(2);
    }
  }

  return { agentUrl, protocol, authToken: finalAuthToken, oauthTokens, oauthClient, aliasId };
}

async function handleComplyCommand(args) {
  // 'adcp comply' is an alias for 'adcp storyboard run'
  if (!args.includes('--json') && !args.includes('--help') && !args.includes('-h')) {
    console.error('DEPRECATED: "adcp comply" will be removed. Use "adcp storyboard run" instead.\n');
  }

  if (args.includes('--help') || args.length === 0) {
    console.log(`
DEPRECATED: "adcp comply" will be removed in v5.
Use "adcp storyboard run" instead. Run "adcp storyboard run --help" for full usage.
`);
    return;
  }

  // Delegate to storyboard run (full assessment mode)
  await handleStoryboardRun(args);
}

function printUsage() {
  console.log(`
AdCP CLI Tool

USAGE:
  adcp <agent> [tool] [payload] [options]
  adcp <command> [args]

COMMANDS:
  storyboard <subcommand>     Test agent flows (run, list, show, step)
  grade <subject> <url>       Conformance graders (e.g. request-signing)
  signing <subcommand>        RFC 9421 signing key tools (generate, verify)
  check-network               Validate managed publisher network deployment
  diagnose-auth <alias|url>   Diagnose OAuth handshake with ranked hypotheses
                              (alias: "adcp diagnose oauth <alias|url>")
  comply <agent> [options]    DEPRECATED — use "storyboard run" instead
  test <agent> [scenario]     Run individual test scenarios (legacy)
  registry <command>          Brand/property registry lookups

  Run 'adcp <command> --help' for details on each command.

QUICK START:
  adcp test-mcp                                    List tools on the test agent
  adcp test-mcp get_products '{"brief":"coffee"}'  Call a tool
  adcp storyboard run test-mcp                     Run capability-driven assessment
  adcp storyboard run test-mcp media_buy_seller    Run a single storyboard or bundle
  adcp test test-mcp full_sales_flow               Run test scenario

AGENT MANAGEMENT:
  --save-auth <alias> [url]   Save agent with alias (supports --auth, --no-auth, --oauth)
  --list-agents               List saved agents
  --remove-agent <alias>      Remove saved agent
  --show-config               Show config location

OPTIONS:
  --protocol PROTO  Force protocol: mcp or a2a (default: auto-detect)
  --auth TOKEN      Authentication token
  --oauth           OAuth authentication (MCP only, opens browser)
  --clear-oauth     Clear saved OAuth tokens
  --wait            Wait for async/webhook responses
  --json            Raw JSON output
  --debug           Debug output
  --allow-v2        Suppress the v2-sunset warning (unsupported since 2026-04-20)
  --help, -h        Show help

BUILT-IN AGENTS:
  test-mcp          AdCP public test agent (MCP)
  test-a2a          AdCP public test agent (A2A)
  test-no-auth      Test agent without auth (MCP)
  test-a2a-no-auth  Test agent without auth (A2A)
  creative          AdCP creative agent (MCP)

Full documentation: https://github.com/adcontextprotocol/adcp-client/blob/main/docs/CLI.md
`);
}

// ────────────────────────────────────────────────────────────
// Storyboard command
// ────────────────────────────────────────────────────────────

async function handleStoryboardCommand(args) {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
Storyboard-driven testing

USAGE:
  adcp storyboard list [--json]
  adcp storyboard show <id> [--json]
  adcp storyboard run <agent> [id|bundle] [options]
  adcp storyboard run <agent> --file <path.yaml> [options]
  adcp storyboard step <agent> <storyboard_id> <step_id> [options]

SUBCOMMANDS:
  list                Enumerate storyboards in the compliance cache
  show <id>           Show storyboard structure (phases, steps)
  run <agent> [id]    Run storyboards. With id, run one bundle/storyboard; otherwise
                      the agent's get_adcp_capabilities drives selection.
  step <agent> <id> <step_id>  Run a single step (stateless, LLM-friendly)

RUN OPTIONS (full assessment):
  --tracks TRACKS     Comma-separated tracks to include in the report
  --storyboards IDS   Comma-separated storyboard/bundle IDs to run
  --file PATH         Run an ad-hoc storyboard YAML (spec evolution)
  --timeout SECONDS   Timeout in seconds (default: 120)
  --brief TEXT        Custom brief for product discovery

WEBHOOK OPTIONS:
  --webhook-receiver [MODE]       Host an ephemeral receiver so expect_webhook*
                                  steps can grade outbound webhooks. MODE is
                                  "loopback" (default, 127.0.0.1) or "proxy"
                                  (operator-supplied public URL). Required for
                                  the webhook-emission and idempotency bundles
                                  to produce grades instead of skips.
  --webhook-receiver-port PORT    Force a bind port (default: auto-assign).
  --webhook-receiver-public-url URL
                                  Public HTTPS base URL for proxy mode. Implies
                                  --webhook-receiver proxy when used alone.
                                  Incompatible with --multi-instance-strategy
                                  multi-pass (receiver URL is per-pass).
  --webhook-receiver-auto-tunnel  Autodetect a tunnel binary on PATH (ngrok or
                                  cloudflared; override with $ADCP_WEBHOOK_TUNNEL),
                                  spawn it against the receiver, and plug its
                                  public URL into proxy mode. Cleans up on exit.
                                  Custom override: $ADCP_WEBHOOK_TUNNEL="<cmd>
                                  {port}"; the command must emit a line
                                  containing \`ADCP_TUNNEL_URL=<https-url>\`
                                  on stdout or stderr (first match wins).
                                  HTTP-on-the-wire — spec-compliant.

OPTIONS:
  --context JSON      Pass context from previous step (step only)
  --request JSON      Override sample_request for the step (step only)
  --json              JSON output (recommended for LLM consumption)
  --auth TOKEN        Authentication token
  --protocol PROTO    Force protocol: mcp or a2a
  --dry-run           Preview steps without executing
  --debug             Debug output

NOTE: Storyboards are pulled from the compliance cache populated by
      \`npm run sync-schemas\` (fetches /protocol/{version}.tgz).

EXAMPLES:
  adcp storyboard run test-mcp                         # capability-driven assessment
  adcp storyboard run test-mcp --tracks core,products  # filter report by track
  adcp storyboard run test-mcp sales-guaranteed        # run one specialism bundle
  adcp storyboard run test-mcp --file ./my-wip.yaml    # test a local YAML
  adcp storyboard run test-mcp webhook-emission --webhook-receiver
                                                       # grade outbound webhooks via loopback receiver
  adcp storyboard run my-remote idempotency \\
    --webhook-receiver proxy --webhook-receiver-public-url https://run.example.com
                                                       # remote agent via tunnel (ngrok/cloudflared/ingress)
  adcp storyboard run my-remote webhook-emission --webhook-receiver-auto-tunnel
                                                       # remote agent, tunnel autodetected + managed
  adcp storyboard list
  adcp storyboard show media_buy_seller
  adcp storyboard step test-mcp media_buy_seller sync_accounts --json
`);
    process.exit(0);
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
      await handleStoryboardList(subArgs);
      break;
    case 'show':
      await handleStoryboardShow(subArgs);
      break;
    case 'run':
      await handleStoryboardRun(subArgs);
      break;
    case 'step':
      await handleStoryboardStepCmd(subArgs);
      break;
    default:
      console.error(`Unknown storyboard subcommand: ${subcommand}`);
      console.error('Available: list, show, run, step');
      process.exit(2);
  }
}

async function handleStoryboardList(args) {
  const { listBundles, loadBundleStoryboards } = await import('../dist/lib/testing/storyboard/index.js');
  const jsonOutput = args.includes('--json');
  // --stateful: keep only storyboards that contain at least one step marked
  // `stateful: true`. That's the same predicate the multi-instance runner
  // uses to identify storyboards whose write→read chains surface in-process
  // state bugs, so this filter returns the "worth round-robining" set.
  const statefulOnly = args.includes('--stateful');

  let bundles;
  try {
    bundles = listBundles();
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  const grouped = { universal: [], protocol: [], specialism: [] };
  const flat = [];
  for (const ref of bundles) {
    const storyboards = loadBundleStoryboards(ref);
    if (storyboards.length === 0) continue; // skip schema/fixture YAMLs that aren't runnable
    const summaryStoryboards = storyboards
      .map(s => {
        const allSteps = s.phases.flatMap(p => p.steps);
        const statefulStepCount = allSteps.filter(step => step.stateful === true).length;
        return {
          id: s.id,
          title: s.title,
          category: s.category,
          summary: s.summary,
          track: s.track,
          step_count: allSteps.length,
          stateful_step_count: statefulStepCount,
        };
      })
      .filter(s => !statefulOnly || s.stateful_step_count > 0);
    if (summaryStoryboards.length === 0) continue;
    const summary = { bundle_kind: ref.kind, bundle_id: ref.id, storyboards: summaryStoryboards };
    grouped[ref.kind].push(summary);
    for (const sb of summaryStoryboards) {
      flat.push({ ...sb, bundle_kind: ref.kind, bundle_id: ref.id });
    }
  }

  if (jsonOutput) {
    await writeJsonOutput({ bundles: grouped, storyboards: flat, filter: statefulOnly ? 'stateful' : null });
    return;
  }

  const heading = statefulOnly
    ? 'Stateful compliance storyboards (1+ step marked stateful: true)'
    : 'Compliance storyboards (from local cache)';
  console.log(`\n${heading}\n`);
  for (const kind of ['universal', 'protocol', 'specialism']) {
    if (grouped[kind].length === 0) continue;
    const header =
      kind === 'universal' ? 'Universal (required for all agents)' : kind === 'protocol' ? 'Protocols' : 'Specialisms';
    console.log(`${header}:`);
    for (const bundle of grouped[kind]) {
      console.log(`  [${bundle.bundle_id}]`);
      for (const sb of bundle.storyboards) {
        const statefulSuffix = statefulOnly || sb.stateful_step_count > 0 ? `, ${sb.stateful_step_count} stateful` : '';
        console.log(`    ${sb.id}  — ${sb.title} (${sb.step_count} steps${statefulSuffix})`);
        if (sb.track) console.log(`      Track: ${sb.track}`);
      }
    }
    console.log();
  }
  const suffix = statefulOnly ? ' with at least one stateful step' : '';
  console.log(
    `${flat.length} storyboard(s)${suffix} across ${grouped.universal.length + grouped.protocol.length + grouped.specialism.length} bundle(s).`
  );
}

async function handleStoryboardShow(args) {
  const { resolveBundleOrStoryboard, findBundleById, listAllComplianceStoryboards } =
    await import('../dist/lib/testing/storyboard/index.js');
  const jsonOutput = args.includes('--json');
  const positionalArgs = args.filter(a => !a.startsWith('--'));
  const storyboardId = positionalArgs[0];

  if (!storyboardId) {
    console.error('Usage: adcp storyboard show <id>');
    process.exit(2);
  }

  const matches = resolveBundleOrStoryboard(storyboardId);
  if (matches.length === 0) {
    console.error(`Storyboard or bundle not found: ${storyboardId}`);
    console.error(
      `Available: ${listAllComplianceStoryboards()
        .map(s => s.id)
        .join(', ')}`
    );
    process.exit(2);
  }

  const storyboard = matches[0];
  const bundle = findBundleById(storyboardId);
  if (bundle && matches.length > 1 && !jsonOutput) {
    console.log(
      `\n[${bundle.kind} bundle "${bundle.id}"] contains ${matches.length} storyboards: ${matches
        .map(s => s.id)
        .join(', ')}`
    );
    console.log(`Showing first (${storyboard.id}). Run 'storyboard show <id>' for another.`);
  }

  if (jsonOutput) {
    await writeJsonOutput(storyboard);
  } else {
    console.log(`\n${storyboard.title}`);
    console.log(`${'─'.repeat(storyboard.title.length)}`);
    console.log(`ID: ${storyboard.id}  |  Category: ${storyboard.category}  |  Version: ${storyboard.version}`);
    if (storyboard.track) console.log(`Track: ${storyboard.track}`);
    console.log(`\n${storyboard.summary}`);
    if (storyboard.narrative) {
      console.log(`\n${storyboard.narrative.trim()}`);
    }
    console.log();

    for (const phase of storyboard.phases) {
      const stepCount = phase.steps.length;
      console.log(`Phase: ${phase.title} (${stepCount} step${stepCount !== 1 ? 's' : ''})`);
      if (phase.narrative) {
        // Indent phase narrative
        const lines = phase.narrative.trim().split('\n');
        for (const line of lines) {
          console.log(`  ${line}`);
        }
        console.log();
      }
      for (const step of phase.steps) {
        const validationCount = step.validations?.length || 0;
        const statefulTag = step.stateful ? ' [stateful]' : '';
        console.log(`  → ${step.id}: ${step.title}${statefulTag}`);
        console.log(`    Task: ${step.task}  |  Validations: ${validationCount}`);
        if (step.expected) {
          // Show expected on one line, trimmed
          const expected = step.expected.trim().split('\n')[0];
          console.log(`    Expected: ${expected}`);
        }
      }
      console.log();
    }
  }
}

async function handleStoryboardRun(args) {
  const opts = parseAgentOptions(args);
  const { authToken, protocolFlag, jsonOutput, dryRun, positionalArgs, file: filePath } = opts;

  // Multi-instance mode: repeated --url flags round-robin steps across N
  // seller URLs. Must share a backing store to pass — catches horizontal
  // scaling bugs where brand-scoped state lives in-process.
  const extraUrls = extractRepeatedUrlFlags(args);
  if (extraUrls.length > 0) {
    return handleMultiInstanceStoryboardRun(args, opts, extraUrls);
  }

  const agentArg = positionalArgs[0];
  const storyboardId = positionalArgs[1];

  if (!agentArg) {
    console.error('Usage: adcp storyboard run <agent> [storyboard_id|--file path] [options]');
    console.error('  Multi-instance: adcp storyboard run --url <url1> --url <url2> <storyboard_id|bundle_id>');
    process.exit(2);
  }

  if (filePath && storyboardId) {
    console.error('ERROR: Cannot combine a storyboard ID with --file. Use one or the other.');
    process.exit(2);
  }

  // No storyboard ID and no --file → capability-driven full assessment.
  if (!storyboardId && !filePath) {
    await runFullAssessment(agentArg, args, opts);
    return;
  }

  // Passing a bundle id expands to all storyboards in that bundle; route through comply().
  if (storyboardId) {
    await runFullAssessment(agentArg, args, { ...opts, explicitStoryboards: [storyboardId] });
    return;
  }

  const { loadStoryboardFile, runStoryboard } = await import('../dist/lib/testing/storyboard/index.js');
  let storyboard;
  try {
    storyboard = loadStoryboardFile(filePath);
  } catch (err) {
    console.error(`Failed to load storyboard from ${filePath}: ${err.message}`);
    process.exit(2);
  }

  const {
    agentUrl,
    protocol,
    authToken: resolvedAuth,
  } = await resolveAgent(agentArg, authToken, protocolFlag, jsonOutput);

  // Parse webhook-receiver flags up front so malformed values fail the run
  // before the dry-run short-circuit, not only on a live execution. Auto-tunnel
  // is resolved after the dry-run gate — spawning a tunnel for a preview-only
  // run would be wasteful — but its flag-combination validation runs here so
  // conflicts surface in dry-run too.
  const webhookAutoTunnel = args.includes('--webhook-receiver-auto-tunnel');
  const webhookReceiverBase = extractWebhookReceiverOptions(args);
  validateAutoTunnelArgs(args, webhookReceiverBase);

  const stepCount = storyboard.phases.reduce((sum, p) => sum + p.steps.length, 0);

  if (!jsonOutput) {
    console.error(`Running storyboard: ${storyboard.title}`);
    console.error(`Agent: ${agentUrl} (${protocol})`);
    console.error(`Steps: ${stepCount}\n`);
  }

  // --dry-run: preview mode — show the plan without executing
  if (dryRun) {
    if (jsonOutput) {
      await writeJsonOutput({
        storyboard_id: storyboard.id,
        storyboard_title: storyboard.title,
        agent_url: agentUrl,
        protocol,
        preview: true,
        phases: storyboard.phases.map(p => ({
          phase: p.title,
          steps: p.steps.map(s => ({ id: s.id, title: s.title, task: s.task })),
        })),
      });
    } else {
      console.log(`\n${storyboard.title} (${storyboard.id})`);
      console.log('═'.repeat(50));
      for (const phase of storyboard.phases) {
        console.log(`\n── Phase: ${phase.title} ──`);
        for (const step of phase.steps) {
          console.log(`  ${step.id}: ${step.title} → ${step.task}`);
        }
      }
      console.log(`\n${stepCount} step(s) would be executed. Use without --dry-run to run.`);
    }
    return;
  }

  const webhookReceiverOpts = webhookAutoTunnel
    ? await resolveWebhookReceiverOptions(args, { jsonOutput })
    : webhookReceiverBase;

  const options = {
    protocol,
    ...(resolvedAuth ? { auth: { type: 'bearer', token: resolvedAuth } } : {}),
    ...(webhookReceiverOpts ?? {}),
  };

  const restoreLogs = jsonOutput ? captureStdoutLogs() : null;
  let result;
  try {
    result = await runStoryboard(agentUrl, storyboard, options);
  } finally {
    if (restoreLogs) restoreLogs();
  }

  if (jsonOutput) {
    await writeJsonOutput(result);
  } else {
    // Human-readable output
    console.log(`\n${storyboard.title} (${storyboard.id})`);
    console.log('═'.repeat(50));
    for (const phase of result.phases) {
      console.log(`\n── Phase: ${phase.phase_title} ──────────────────────────────`);
      const SKIP_ICONS = {
        missing_tool: '🔧',
        missing_test_controller: '🔧',
        not_applicable: '⏭️',
        no_phases: '⏭️',
        prerequisite_failed: '⏭️',
        unsatisfied_contract: '⏭️',
      };
      const SKIP_LABELS = {
        missing_tool: ' [missing tool]',
        missing_test_controller: ' [needs test controller]',
        not_applicable: ' [not applicable]',
        no_phases: ' [no phases]',
        prerequisite_failed: ' [prerequisite failed]',
        unsatisfied_contract: ' [contract out of scope]',
      };
      for (const step of phase.steps) {
        const icon = step.skipped ? (SKIP_ICONS[step.skip_reason] ?? '⏭️') : step.passed ? '✅' : '❌';
        const skipLabel = SKIP_LABELS[step.skip_reason] ?? '';
        console.log(`\n${icon} ${step.title}${skipLabel} (${step.duration_ms}ms)`);
        console.log(`   Task: ${step.task}`);
        if (step.error) {
          console.log(`   Error: ${step.error}`);
        }
        for (const v of step.validations) {
          const vIcon = v.passed ? '✅' : '❌';
          console.log(`   ${vIcon} ${v.description}`);
          if (v.error) console.log(`      ${v.error}`);
        }
      }
    }

    console.log(`\n${'─'.repeat(50)}`);
    const overallIcon = result.overall_passed ? '✅' : '❌';
    console.log(
      `${overallIcon} ${result.passed_count} passed, ${result.failed_count} failed, ${result.skipped_count} skipped (${result.total_duration_ms}ms)`
    );
  }

  process.exit(result.overall_passed ? 0 : 3);
}

/**
 * Extract every `--url <value>` occurrence from the CLI args and validate
 * each against the same policy the single-instance agent argument enforces:
 *
 *  - value must be a parseable URL
 *  - scheme must be http or https (http only allowed with --allow-http)
 *  - no userinfo (`https://user:pass@host/` is rejected — tokens go via --auth)
 *
 * Without these gates a hostile or typo'd `--url file:///etc/passwd` or
 * `--url https://attacker@victim/mcp` would flow straight into the MCP
 * transport and land in attribution output.
 */
/**
 * Parse `--webhook-receiver [mode]`, `--webhook-receiver-port <port>`, and
 * `--webhook-receiver-public-url <url>`. Returns a `{ webhook_receiver, contracts }`
 * pair suitable for spreading into `runStoryboard` / `comply` options, or
 * `null` if no webhook-receiver flag is set.
 *
 * The receiver's presence satisfies the `webhook_receiver_runner` test-kit
 * contract; storyboards with `requires_contract: webhook_receiver_runner`
 * (e.g. the `webhook-emission` and `idempotency` universals) otherwise skip.
 *
 * Exits with code 2 on invalid flag shape.
 */
function extractWebhookReceiverOptions(args) {
  const idx = args.indexOf('--webhook-receiver');
  const publicUrlIdx = args.indexOf('--webhook-receiver-public-url');
  const portIdx = args.indexOf('--webhook-receiver-port');

  if (idx === -1 && publicUrlIdx === -1 && portIdx === -1) return null;

  let mode = 'loopback_mock';
  if (idx !== -1) {
    const next = args[idx + 1];
    if (next !== undefined && !next.startsWith('--')) {
      if (next === 'loopback') mode = 'loopback_mock';
      else if (next === 'proxy') mode = 'proxy_url';
      else {
        console.error(`ERROR: --webhook-receiver value must be "loopback" or "proxy", got "${next}"`);
        console.error('       Omit the value to use the default (loopback).');
        process.exit(2);
      }
    }
  }

  let publicUrl;
  if (publicUrlIdx !== -1) {
    const val = args[publicUrlIdx + 1];
    if (val === undefined || val.startsWith('--')) {
      console.error('ERROR: --webhook-receiver-public-url requires a URL value');
      process.exit(2);
    }
    publicUrl = val;
    // --webhook-receiver-public-url without --webhook-receiver implies proxy mode.
    // With explicit `--webhook-receiver loopback`, the combination is a user
    // error — loopback mode ignores public_url.
    if (idx === -1) mode = 'proxy_url';
  }

  if (mode === 'proxy_url' && !publicUrl) {
    console.error('ERROR: --webhook-receiver proxy requires --webhook-receiver-public-url <url>');
    process.exit(2);
  }
  if (mode === 'loopback_mock' && publicUrl) {
    console.error('ERROR: --webhook-receiver-public-url is only valid with --webhook-receiver proxy');
    process.exit(2);
  }

  let port;
  if (portIdx !== -1) {
    const raw = args[portIdx + 1];
    if (raw === undefined || raw.startsWith('--')) {
      console.error('ERROR: --webhook-receiver-port requires a port number');
      process.exit(2);
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || String(parsed) !== raw) {
      console.error(`ERROR: --webhook-receiver-port must be an integer, got "${raw}"`);
      process.exit(2);
    }
    if (parsed < 0 || parsed > 65535) {
      console.error(`ERROR: --webhook-receiver-port must be between 0 and 65535, got ${parsed}`);
      process.exit(2);
    }
    port = parsed;
  }

  return {
    webhook_receiver: {
      mode,
      ...(port !== undefined && { port }),
      ...(publicUrl !== undefined && { public_url: publicUrl }),
    },
    contracts: ['webhook_receiver_runner'],
  };
}

/**
 * `--webhook-receiver-auto-tunnel` autodetects a tunneling binary on PATH
 * (ngrok or cloudflared), spawns it pointed at the receiver port, extracts
 * the public URL, and plumbs it into `webhook_receiver` proxy mode — so a
 * developer grading a remote agent from a laptop doesn't have to stand up
 * a tunnel by hand.
 *
 * Design notes:
 *  - HTTP on the wire is unchanged. This satisfies the webhook_receiver_runner
 *    parity invariant (loopback_mock ≡ proxy_url — same emitter path).
 *  - No vendor pin: any binary on PATH works, and `$ADCP_WEBHOOK_TUNNEL`
 *    overrides detection with a custom command template (`{port}` is
 *    substituted). This keeps the CLI spec-compliant with the test-kit's
 *    "MUST NOT require a specific tunnel vendor" rule.
 *
 * The detection logic is PATH-based (not exec-based) so we can fail fast
 * with a clear message when no tunnel is installed, instead of surfacing
 * ENOENT after a runStoryboard attempt is already in flight.
 */
function isOnPath(cmd) {
  const pathEnv = process.env.PATH || '';
  const pathExt = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE').split(';') : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of pathExt) {
      const full = path.join(dir, cmd + ext);
      try {
        if (statSync(full).isFile()) return true;
      } catch {
        /* not this dir */
      }
    }
  }
  return false;
}

function detectTunnelCommand() {
  const override = process.env.ADCP_WEBHOOK_TUNNEL;
  if (override) return { kind: 'custom', template: override };
  if (isOnPath('ngrok')) return { kind: 'ngrok' };
  if (isOnPath('cloudflared')) return { kind: 'cloudflared' };
  return null;
}

function parseTunnelTimeoutMs(raw) {
  const DEFAULT = 15000;
  if (raw === undefined || raw === '') return DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `WARNING: ADCP_WEBHOOK_TUNNEL_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive number; using default ${DEFAULT}ms.`
    );
    return DEFAULT;
  }
  return parsed;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawn a tunnel process pointed at `port`, extract its public URL from
 * stdout/stderr within `timeoutMs`, and return `{ publicUrl, cleanup }`.
 * Cleanup is idempotent and registered on process exit/SIGINT/SIGTERM so
 * we don't leave zombie tunnels behind on a Ctrl-C mid-run.
 *
 * Exits with code 2 on failure (no tunnel found, startup timeout, child
 * exit before URL emission) — matching the rest of the CLI's validation
 * error contract.
 */
async function spawnAutoTunnel({ port, timeoutMs, jsonOutput }) {
  const detected = detectTunnelCommand();
  if (!detected) {
    console.error('ERROR: --webhook-receiver-auto-tunnel: no supported tunnel binary found on PATH.');
    console.error('       Install ngrok (https://ngrok.com/download) or cloudflared,');
    console.error('       or set $ADCP_WEBHOOK_TUNNEL="<cmd> {port}" to use a custom tunnel.');
    console.error('       Alternatively, run the tunnel yourself and pass');
    console.error('       --webhook-receiver proxy --webhook-receiver-public-url <url>.');
    process.exit(2);
  }

  let cmd;
  let cmdArgs;
  let urlRegex;
  if (detected.kind === 'ngrok') {
    cmd = 'ngrok';
    // logfmt output is stable across ngrok v2/v3 and keeps us off the TUI.
    cmdArgs = ['http', String(port), '--log=stdout', '--log-format=logfmt'];
    // Anchor on ngrok's `msg="started tunnel"` log line. Vendor-domain
    // allowlisting is fragile — ngrok is migrating free-tier subdomains
    // from `.ngrok-free.app` to `.ngrok-free.dev`, paid tiers use
    // `.ngrok.app`, custom domains use anything. Scoping to the started-
    // tunnel line is the durable invariant: ngrok emits it exactly once
    // per tunnel creation with the forwarding URL in the `url=` field.
    urlRegex = /msg="started tunnel"[^\n]*url=(https:\/\/[^\s"]+)/;
  } else if (detected.kind === 'cloudflared') {
    cmd = 'cloudflared';
    cmdArgs = ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'];
    urlRegex = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/;
  } else {
    const parts = detected.template
      .replace(/\{port\}/g, String(port))
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length === 0) {
      console.error('ERROR: $ADCP_WEBHOOK_TUNNEL is empty.');
      process.exit(2);
    }
    cmd = parts[0];
    cmdArgs = parts.slice(1);
    // Custom templates must print `ADCP_TUNNEL_URL=<https://...>` on a line
    // somewhere in stdout/stderr. An unscoped "first https:// URL" match would
    // wire the tunnel destination to any docs/diagnostics URL the binary
    // happens to log on startup; the explicit marker is the contract.
    urlRegex = /ADCP_TUNNEL_URL=(https:\/\/[^\s"]+)/;
  }

  let child;
  try {
    child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.error(`ERROR: failed to spawn ${cmd}: ${err.message}`);
    process.exit(2);
  }

  let settled = false;
  let publicUrl;

  const scan = chunk => {
    if (settled) return;
    const text = chunk.toString('utf8');
    const m = text.match(urlRegex);
    if (m) {
      publicUrl = m[1];
      settled = true;
    }
  };

  const urlReady = new Promise((resolve, reject) => {
    const onResolved = () => resolve(publicUrl);
    const onRejected = err => reject(err);

    child.stdout.on('data', c => {
      scan(c);
      if (publicUrl) onResolved();
    });
    child.stderr.on('data', c => {
      scan(c);
      if (publicUrl) onResolved();
    });
    child.once('error', err => {
      if (settled) return;
      settled = true;
      if (err.code === 'ENOENT') {
        onRejected(new Error(`${cmd} not on PATH at spawn time`));
      } else {
        onRejected(err);
      }
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      onRejected(new Error(`${cmd} exited (code=${code}, signal=${signal}) before emitting a public URL`));
    });
  });

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${cmd} did not emit a public URL within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );
  });

  try {
    await Promise.race([urlReady, timeout]);
  } catch (err) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    if (timer) clearTimeout(timer);
    console.error(`ERROR: --webhook-receiver-auto-tunnel: ${err.message}`);
    process.exit(2);
  }
  clearTimeout(timer);

  const cleanup = registerTunnelChildForCleanup(child);

  if (!jsonOutput) {
    console.error(`Auto-tunnel (${cmd}): ${publicUrl} → http://localhost:${port}`);
  }

  return { publicUrl, cleanup };
}

/**
 * Shared cleanup registry for spawned tunnel children. One `exit`/`SIGINT`/
 * `SIGTERM` listener is installed the first time a child is registered and
 * stays installed for the process lifetime — `process.once` was a bug
 * waiting to happen (a second Ctrl-C would bypass teardown and leak
 * tunnels).
 *
 * Signal path escalates SIGTERM → SIGKILL with a 250 ms grace so a tunnel
 * that ignores TERM still gets reaped. The `'exit'` path is best-effort:
 * Node cannot schedule timers after the `'exit'` event, so we only send
 * TERM there and rely on the OS to reap strays when the parent dies.
 */
const activeTunnelChildren = new Set();
let tunnelSignalHandlersInstalled = false;
let tunnelEscalating = false;

function termAllTunnels() {
  for (const child of activeTunnelChildren) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

function killAllTunnels() {
  for (const child of activeTunnelChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function installTunnelSignalHandlersOnce() {
  if (tunnelSignalHandlersInstalled) return;
  tunnelSignalHandlersInstalled = true;
  // `process.on` (not `once`) so a second Ctrl-C doesn't bypass cleanup.
  process.on('exit', termAllTunnels);
  const escalateAndExit = exitCode => () => {
    if (tunnelEscalating) {
      // Second signal while we're already escalating: force-kill now and bail.
      killAllTunnels();
      process.exit(exitCode);
    }
    tunnelEscalating = true;
    termAllTunnels();
    // Don't unref — we want Node to wait the full grace before exiting so
    // stubborn tunnels actually see SIGKILL. setTimeout scheduled here fires
    // because we deliberately don't call process.exit synchronously.
    setTimeout(() => {
      killAllTunnels();
      process.exit(exitCode);
    }, 250);
  };
  process.on('SIGINT', escalateAndExit(130));
  process.on('SIGTERM', escalateAndExit(143));
}

function registerTunnelChildForCleanup(child) {
  installTunnelSignalHandlersOnce();
  activeTunnelChildren.add(child);
  child.once('exit', () => activeTunnelChildren.delete(child));
  return () => {
    if (!activeTunnelChildren.delete(child)) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };
}

/**
 * Resolve `webhook_receiver` options with auto-tunnel support layered in.
 *
 * When `--webhook-receiver-auto-tunnel` is present, we allocate a port if
 * the operator didn't force one, spawn the tunnel, and synthesize a
 * proxy-mode receiver config around the captured public URL. The return
 * shape matches `extractWebhookReceiverOptions` so callers can spread it
 * into runner options unchanged.
 */
function validateAutoTunnelArgs(args, base) {
  if (!args.includes('--webhook-receiver-auto-tunnel')) return;
  if (base?.webhook_receiver.public_url) {
    console.error('ERROR: --webhook-receiver-auto-tunnel conflicts with --webhook-receiver-public-url.');
    console.error('       Pick one — auto-tunnel mints a URL for you, public-url supplies your own.');
    process.exit(2);
  }
  // Auto-tunnel implies proxy mode and mints the URL itself. A coexisting
  // `--webhook-receiver [mode]` flag is always wrong: `loopback` contradicts
  // the minted URL, `proxy` without public-url is caught earlier in
  // extractWebhookReceiverOptions, and a bare `--webhook-receiver` (which
  // resolves to `loopback_mock`) would be silently overwritten. Reject all
  // three up front with a single clear message.
  if (args.includes('--webhook-receiver')) {
    console.error('ERROR: --webhook-receiver-auto-tunnel already implies proxy mode; drop `--webhook-receiver`.');
    process.exit(2);
  }
}

async function resolveWebhookReceiverOptions(args, { jsonOutput } = {}) {
  const base = extractWebhookReceiverOptions(args);
  validateAutoTunnelArgs(args, base);
  if (!args.includes('--webhook-receiver-auto-tunnel')) return base;

  const port = base?.webhook_receiver.port ?? (await getFreePort());
  const timeoutMs = parseTunnelTimeoutMs(process.env.ADCP_WEBHOOK_TUNNEL_TIMEOUT_MS);
  const { publicUrl } = await spawnAutoTunnel({ port, timeoutMs, jsonOutput });

  return {
    webhook_receiver: { mode: 'proxy_url', port, public_url: publicUrl },
    contracts: ['webhook_receiver_runner'],
  };
}

/**
 * Parse `--multi-instance-strategy <round-robin|multi-pass>`. Defaults to
 * `round-robin` to keep CI time predictable; operators opt into `multi-pass`
 * when they want cross-replica coverage for write→read pairs separated by an
 * even number of stateful steps (see adcontextprotocol/adcp-client#607).
 */
function extractMultiInstanceStrategy(args) {
  const idx = args.indexOf('--multi-instance-strategy');
  if (idx === -1) return 'round-robin';
  const raw = args[idx + 1];
  if (raw === undefined || raw.startsWith('--')) {
    console.error('ERROR: --multi-instance-strategy requires a value (round-robin|multi-pass)');
    process.exit(2);
  }
  if (raw !== 'round-robin' && raw !== 'multi-pass') {
    console.error(`ERROR: --multi-instance-strategy must be "round-robin" or "multi-pass", got "${raw}"`);
    process.exit(2);
  }
  return raw;
}

function extractRepeatedUrlFlags(args) {
  const allowHttp = args.includes('--allow-http');
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--url') continue;
    const raw = args[i + 1];
    if (raw === undefined || raw.startsWith('--')) {
      console.error('ERROR: --url requires a value (URL)');
      process.exit(2);
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      console.error(`ERROR: --url value is not a valid URL: ${raw}`);
      process.exit(2);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.error(`ERROR: --url must be http(s); got ${parsed.protocol} in "${raw}"`);
      process.exit(2);
    }
    if (parsed.protocol === 'http:' && !allowHttp) {
      console.error(`ERROR: --url with http:// requires --allow-http (got "${raw}")`);
      process.exit(2);
    }
    if (parsed.username || parsed.password) {
      console.error('ERROR: --url must not contain credentials (user:pass@). Pass tokens via --auth.');
      process.exit(2);
    }
    values.push(raw);
  }
  return values;
}

/**
 * Run a storyboard (or bundle) in multi-instance mode. Each step round-robins
 * across the supplied URLs. Positional agent is disallowed — --url is the
 * multi-instance path; positional is the single-instance path.
 *
 * Full capability-driven assessment (no storyboard ID) is intentionally not
 * supported here: the compliance pipeline shares a single client across
 * storyboards for connection reuse, which is incompatible with per-step URL
 * dispatch. Use a specific storyboard or bundle ID.
 */
async function handleMultiInstanceStoryboardRun(args, opts, urls) {
  const { authToken, protocolFlag, jsonOutput, dryRun, positionalArgs, file: filePath } = opts;

  if (urls.length < 2) {
    console.error('ERROR: Multi-instance mode requires 2+ --url flags. Drop --url for single-instance.');
    process.exit(2);
  }

  const strategy = extractMultiInstanceStrategy(args);

  // Parse webhook-receiver flags here so the multi-pass incompatibility fails
  // up front — not after bundle resolution, connection setup, or dispatch.
  const webhookAutoTunnel = args.includes('--webhook-receiver-auto-tunnel');
  const webhookReceiverBase = extractWebhookReceiverOptions(args);
  validateAutoTunnelArgs(args, webhookReceiverBase);
  if ((webhookReceiverBase || webhookAutoTunnel) && strategy === 'multi-pass') {
    // The runner throws on this combination (each pass binds a fresh receiver
    // URL; agents caching pass-1 URLs would deliver to a dead port in pass 2).
    // Surface it as a CLI-level error so operators don't wait for dispatch.
    console.error(
      'ERROR: --webhook-receiver is incompatible with --multi-instance-strategy multi-pass. ' +
        'Use round-robin (the default) when hosting a webhook receiver.'
    );
    process.exit(2);
  }

  // Strip --url values that may have slipped past parseAgentOptions' positional filter.
  const cleanPositional = positionalArgs.filter(p => !urls.includes(p));
  const firstPositional = cleanPositional[0];

  if (firstPositional && (firstPositional.startsWith('http://') || firstPositional.startsWith('https://'))) {
    console.error(
      'ERROR: Cannot combine a positional agent URL with --url flags. ' +
        'Use either a positional agent (single-instance) or repeated --url flags (multi-instance).'
    );
    process.exit(2);
  }

  const storyboardId = firstPositional;

  if (filePath && storyboardId) {
    console.error('ERROR: Cannot combine a storyboard ID with --file. Use one or the other.');
    process.exit(2);
  }

  if (!filePath && !storyboardId) {
    console.error(
      'ERROR: Multi-instance mode requires a storyboard ID, bundle ID, or --file. ' +
        'Capability-driven full assessment is not yet multi-instance aware.'
    );
    process.exit(2);
  }

  const { loadStoryboardFile, runStoryboard, getComplianceStoryboardById, loadBundleStoryboards, findBundleById } =
    await import('../dist/lib/testing/storyboard/index.js');

  // Load one or more storyboards (bundle IDs expand).
  const storyboards = [];
  if (filePath) {
    try {
      storyboards.push(loadStoryboardFile(filePath));
    } catch (err) {
      console.error(`Failed to load storyboard from ${filePath}: ${err.message}`);
      process.exit(2);
    }
  } else {
    const bundle = findBundleById(storyboardId);
    if (bundle) {
      const bundleStoryboards = loadBundleStoryboards(storyboardId);
      if (!bundleStoryboards || bundleStoryboards.length === 0) {
        console.error(`ERROR: Bundle "${storyboardId}" is empty.`);
        process.exit(2);
      }
      storyboards.push(...bundleStoryboards);
    } else {
      const sb = getComplianceStoryboardById(storyboardId);
      if (!sb) {
        console.error(
          `ERROR: Unknown storyboard or bundle ID: ${storyboardId}\n` + `Run 'adcp storyboard list' to see all options.`
        );
        process.exit(2);
      }
      storyboards.push(sb);
    }
  }

  // Auto-detect protocol from the first URL. Multi-instance deployments
  // share a codebase across replicas, so one probe is representative.
  let protocol = protocolFlag;
  if (!protocol) {
    if (!jsonOutput) console.error('Auto-detecting protocol from first URL...');
    try {
      protocol = await detectProtocol(urls[0]);
      if (!jsonOutput) console.error(`Detected protocol: ${protocol.toUpperCase()}\n`);
    } catch (err) {
      console.error(`ERROR: Failed to detect protocol: ${err.message}`);
      process.exit(1);
    }
  }

  const totalSteps = storyboards.reduce(
    (sum, sb) => sum + sb.phases.reduce((phaseSum, p) => phaseSum + p.steps.length, 0),
    0
  );

  if (!jsonOutput) {
    const strategyLabel = strategy === 'multi-pass' ? `multi-pass (${urls.length} passes)` : `round-robin (1 pass)`;
    console.error(`Multi-instance storyboard run (${strategyLabel} across ${urls.length} instances):`);
    urls.forEach((u, i) => console.error(`  [#${i + 1}] ${u}`));
    console.error(`  Protocol: ${protocol.toUpperCase()}`);
    console.error(`  Storyboards: ${storyboards.map(s => s.id).join(', ')}`);
    const effectiveSteps = strategy === 'multi-pass' ? totalSteps * urls.length : totalSteps;
    console.error(
      `  Total steps: ${effectiveSteps}${strategy === 'multi-pass' ? ` (${totalSteps} × ${urls.length} passes)` : ''}\n`
    );
    // N=2 is the deployment shape most operators have. Offset-shift preserves
    // pair parity there, so every even-distance write→read pair lands
    // same-replica in every pass — including the canonical property_lists
    // case. Print a visible caveat so operators don't read "multi-pass" as
    // "full cross-replica state coverage."
    if (strategy === 'multi-pass' && urls.length === 2) {
      console.error(
        'Caveat: multi-pass at N=2 does NOT cover cross-replica write→read pairs at\n' +
          'even dispatch-index distance (e.g., write at step 0, read at step 2).\n' +
          'Use round-robin for adjacent pairs; see docs/guides/MULTI-INSTANCE-TESTING.md\n' +
          'for the full coverage story. Multi-pass is useful for catching single-replica\n' +
          'config/version/cache bugs that pure round-robin may miss.\n'
      );
    }
  }

  // --dry-run: print the assignment plan and exit
  if (dryRun) {
    // Multi-pass runs the same storyboard once per pass, with the dispatcher
    // starting at a different replica each time; round-robin is the special
    // case of one pass.
    const passCount = strategy === 'multi-pass' ? urls.length : 1;
    const passOffsets = Array.from({ length: passCount }, (_, i) => i);
    const assignmentsFor = (sb, offset) => {
      const flat = sb.phases.flatMap(p => p.steps);
      return flat.map((s, idx) => {
        const pos = (idx + offset) % urls.length;
        return {
          step_id: s.id,
          task: s.task,
          instance_index: pos + 1,
          agent_url: urls[pos],
        };
      });
    };
    if (jsonOutput) {
      await writeJsonOutput({
        agent_urls: urls,
        multi_instance_strategy: strategy,
        protocol,
        preview: true,
        storyboards: storyboards.map(sb => ({
          storyboard_id: sb.id,
          storyboard_title: sb.title,
          ...(strategy === 'multi-pass'
            ? {
                passes: passOffsets.map(o => ({
                  pass_index: o + 1,
                  dispatch_offset: o,
                  assignments: assignmentsFor(sb, o),
                })),
              }
            : { assignments: assignmentsFor(sb, 0) }),
        })),
      });
    } else {
      for (const sb of storyboards) {
        console.log(`\n${sb.title} (${sb.id})`);
        console.log('═'.repeat(50));
        for (const offset of passOffsets) {
          if (strategy === 'multi-pass') {
            console.log(`\n── Pass ${offset + 1} of ${passCount} (starts at [#${offset + 1}]) ──`);
          }
          let stepIdx = 0;
          for (const phase of sb.phases) {
            console.log(`\n── Phase: ${phase.title} ──`);
            for (const step of phase.steps) {
              const inst = ((stepIdx + offset) % urls.length) + 1;
              console.log(`  [#${inst}] ${step.id}: ${step.title} → ${step.task}`);
              stepIdx++;
            }
          }
        }
      }
      const effective = totalSteps * passCount;
      console.log(
        `\n${effective} step(s) would be executed across ${urls.length} instances${strategy === 'multi-pass' ? ` over ${passCount} passes` : ''}. Use without --dry-run to run.`
      );
    }
    return;
  }

  const webhookReceiverOpts = webhookAutoTunnel
    ? await resolveWebhookReceiverOptions(args, { jsonOutput })
    : webhookReceiverBase;

  const runOptions = {
    protocol,
    ...(authToken ? { auth: { type: 'bearer', token: authToken } } : {}),
    ...(opts.allowHttp && { allow_http: true }),
    multi_instance_strategy: strategy,
    ...(webhookReceiverOpts ?? {}),
  };

  const restoreLogs = jsonOutput ? captureStdoutLogs() : null;
  const results = [];
  let hadFailure = false;
  try {
    for (const sb of storyboards) {
      const result = await runStoryboard(urls, sb, runOptions);
      results.push(result);
      if (!result.overall_passed) hadFailure = true;
    }
  } finally {
    if (restoreLogs) restoreLogs();
  }

  if (jsonOutput) {
    await writeJsonOutput(
      results.length === 1
        ? results[0]
        : {
            agent_urls: urls,
            multi_instance_strategy: strategy,
            storyboards: results,
            overall_passed: !hadFailure,
          }
    );
  } else {
    const SKIP_ICONS = { missing_test_harness: '🔧', not_testable: '⏭️', dependency_failed: '⏭️' };
    const SKIP_LABELS = {
      missing_test_harness: ' [needs test harness]',
      not_testable: ' [not testable]',
      dependency_failed: ' [dependency failed]',
    };
    for (const result of results) {
      console.log(`\n${result.storyboard_title} (${result.storyboard_id})`);
      console.log('═'.repeat(50));
      for (const phase of result.phases) {
        console.log(`\n── Phase: ${phase.phase_title} ──────────────────────────────`);
        for (const step of phase.steps) {
          const icon = step.skipped ? (SKIP_ICONS[step.skip_reason] ?? '⏭️') : step.passed ? '✅' : '❌';
          const skipLabel = SKIP_LABELS[step.skip_reason] ?? '';
          const instTag = step.agent_index ? `[#${step.agent_index}] ` : '';
          console.log(`\n${icon} ${instTag}${step.title}${skipLabel} (${step.duration_ms}ms)`);
          console.log(`   Task: ${step.task}`);
          if (step.error) {
            console.log(`   Error: ${step.error}`);
          }
          for (const v of step.validations) {
            const vIcon = v.passed ? '✅' : '❌';
            console.log(`   ${vIcon} ${v.description}`);
            if (v.error) console.log(`      ${v.error}`);
          }
        }
      }
    }
    console.log(`\n${'─'.repeat(50)}`);
    const totals = results.reduce(
      (acc, r) => ({
        passed: acc.passed + r.passed_count,
        failed: acc.failed + r.failed_count,
        skipped: acc.skipped + r.skipped_count,
        duration: acc.duration + r.total_duration_ms,
      }),
      { passed: 0, failed: 0, skipped: 0, duration: 0 }
    );
    const overallIcon = !hadFailure ? '✅' : '❌';
    const passSuffix =
      strategy === 'multi-pass'
        ? ` across ${urls.length} passes × ${urls.length} instances`
        : ` across ${urls.length} instances`;
    console.log(
      `${overallIcon} ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped (${totals.duration}ms)${passSuffix}`
    );
  }

  process.exit(hadFailure ? 3 : 0);
}

// Shared implementation: run all matching storyboards against an agent
async function runFullAssessment(agentArg, rawArgs, parsedOpts) {
  const opts = parsedOpts || parseAgentOptions(rawArgs);

  const {
    agentUrl,
    protocol,
    authToken: finalAuthToken,
    oauthTokens,
    oauthClient,
  } = await resolveAgent(agentArg, opts.authToken, opts.protocolFlag, opts.jsonOutput);

  // Parse --tracks
  const tracksIndex = rawArgs.indexOf('--tracks');
  let tracks;
  if (tracksIndex !== -1 && tracksIndex + 1 < rawArgs.length) {
    tracks = rawArgs[tracksIndex + 1].split(',');
  }

  // Parse --storyboards (explicit bundle or storyboard IDs); positional overrides.
  const storyboardsIndex = rawArgs.indexOf('--storyboards');
  let storyboards = opts.explicitStoryboards;
  if (!storyboards && storyboardsIndex !== -1 && storyboardsIndex + 1 < rawArgs.length) {
    storyboards = rawArgs[storyboardsIndex + 1].split(',');
  }
  if (storyboards?.length) {
    const { listAllComplianceStoryboards, listBundles } = await import('../dist/lib/testing/storyboard/index.js');
    try {
      const knownStoryboardIds = new Set(listAllComplianceStoryboards().map(s => s.id));
      const knownBundleIds = new Set(listBundles().map(b => b.id));
      const unknown = storyboards.filter(id => !knownStoryboardIds.has(id) && !knownBundleIds.has(id));
      if (unknown.length > 0) {
        console.error(`ERROR: Unknown storyboard or bundle ID(s): ${unknown.join(', ')}`);
        console.error(`Run 'adcp storyboard list' to see all options.\n`);
        process.exit(2);
      }
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      process.exit(1);
    }
  }

  // Parse --timeout (seconds, default 120)
  const timeoutFlagIndex = rawArgs.indexOf('--timeout');
  const DEFAULT_TIMEOUT_S = 120;
  let timeoutMs = DEFAULT_TIMEOUT_S * 1000;
  if (timeoutFlagIndex !== -1) {
    if (timeoutFlagIndex + 1 >= rawArgs.length || rawArgs[timeoutFlagIndex + 1].startsWith('--')) {
      console.error('ERROR: --timeout requires a value (seconds)\n');
      process.exit(2);
    }
    const seconds = parseInt(rawArgs[timeoutFlagIndex + 1], 10);
    if (isNaN(seconds) || seconds <= 0) {
      console.error(`ERROR: --timeout must be a positive integer (seconds), got: ${rawArgs[timeoutFlagIndex + 1]}`);
      process.exit(2);
    }
    timeoutMs = seconds * 1000;
  }

  // OAuth tokens take precedence over a bare bearer — the OAuth provider path
  // auto-refreshes on 401 while a raw bearer can't recover.
  const authOption = oauthTokens
    ? { type: 'oauth', tokens: oauthTokens, ...(oauthClient && { client: oauthClient }) }
    : finalAuthToken
      ? { type: 'bearer', token: finalAuthToken }
      : undefined;

  const webhookReceiverOpts = await resolveWebhookReceiverOptions(rawArgs, { jsonOutput: opts.jsonOutput });
  const testOptions = {
    protocol,
    brief: opts.brief,
    tracks,
    storyboards,
    timeout_ms: timeoutMs,
    agent_alias: agentArg !== agentUrl ? agentArg : undefined,
    ...(authOption && { auth: authOption }),
    ...(opts.allowHttp && { allow_http: true }),
    ...(webhookReceiverOpts ?? {}),
  };

  if (!opts.jsonOutput) {
    const authLabel = authOption ? (authOption.type === 'oauth' ? 'oauth (auto-refresh)' : 'bearer') : 'none';
    console.log(`\nRunning storyboard assessment against ${agentUrl}`);
    console.log(`   Protocol: ${protocol.toUpperCase()}`);
    if (storyboards) console.log(`   Storyboards: ${storyboards.join(', ')}`);
    console.log(`   Timeout: ${timeoutMs / 1000}s`);
    console.log(`   Auth: ${authLabel}`);
    if (opts.allowHttp) console.log(`   ⚠️  --allow-http set — results are not publishable`);
    console.log('');
  }

  const restoreLogs = opts.jsonOutput ? captureStdoutLogs() : null;
  try {
    const { comply, formatComplianceResults, formatComplianceResultsJSON } =
      await import('../dist/lib/testing/compliance/index.js');

    const { setAgentTesterLogger } = await import('../dist/lib/testing/client.js');
    if (!opts.debug) {
      setAgentTesterLogger({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} });
    }

    const result = await comply(agentUrl, testOptions);

    if (opts.jsonOutput) {
      restoreLogs();
      await writeJsonOutput(formatComplianceResultsJSON(result));
    } else {
      console.log(formatComplianceResults(result));
    }

    const hasFailures = result.summary.tracks_failed > 0;
    process.exit(hasFailures ? 3 : 0);
  } catch (error) {
    if (restoreLogs) restoreLogs();
    console.error(`\nAssessment failed: ${error.message}`);
    if (opts.debug) console.error(error.stack);
    process.exit(1);
  }
}

async function handleStoryboardStepCmd(args) {
  const { getComplianceStoryboardById, runStoryboardStep } = await import('../dist/lib/testing/storyboard/index.js');
  const { authToken, protocolFlag, jsonOutput, debug, positionalArgs } = parseAgentOptions(args);

  const agentArg = positionalArgs[0];
  const storyboardId = positionalArgs[1];
  const stepId = positionalArgs[2];

  if (!agentArg || !storyboardId || !stepId) {
    console.error('Usage: adcp storyboard step <agent> <storyboard_id> <step_id> [options]');
    process.exit(2);
  }

  const storyboard = getComplianceStoryboardById(storyboardId);
  if (!storyboard) {
    console.error(`Storyboard not found: ${storyboardId}`);
    process.exit(2);
  }

  const {
    agentUrl,
    protocol,
    authToken: resolvedAuth,
  } = await resolveAgent(agentArg, authToken, protocolFlag, jsonOutput);

  // Parse --context and --request flags (supports inline JSON or @file.json)
  let context = {};
  let request;
  const contextIndex = args.indexOf('--context');
  if (contextIndex !== -1 && args[contextIndex + 1]) {
    context = parseJsonFlag('--context', args[contextIndex + 1]);
  }
  const requestIndex = args.indexOf('--request');
  if (requestIndex !== -1 && args[requestIndex + 1]) {
    request = parseJsonFlag('--request', args[requestIndex + 1]);
  }

  const options = {
    protocol,
    context,
    request,
    ...(resolvedAuth ? { auth: { type: 'bearer', token: resolvedAuth } } : {}),
  };

  const restoreLogs = jsonOutput ? captureStdoutLogs() : null;
  let result;
  try {
    result = await runStoryboardStep(agentUrl, storyboard, stepId, options);
  } finally {
    if (restoreLogs) restoreLogs();
  }

  if (jsonOutput) {
    await writeJsonOutput(result);
  } else {
    const icon = result.passed ? '✅' : '❌';
    console.log(`\n── Step: ${result.title} ──────────────────────────────`);
    console.log(`Task: ${result.task}`);
    console.log(`\n${icon} ${result.passed ? 'Passed' : 'Failed'} (${result.duration_ms}ms)`);

    if (result.error) {
      console.log(`Error: ${result.error}`);
    }

    for (const v of result.validations) {
      const vIcon = v.passed ? '✅' : '❌';
      console.log(`  ${vIcon} ${v.description}`);
      if (v.error) console.log(`     ${v.error}`);
    }

    // Show context
    const contextKeys = Object.keys(result.context);
    if (contextKeys.length > 0) {
      console.log(`\nContext: ${contextKeys.map(k => `${k}=${JSON.stringify(result.context[k])}`).join(', ')}`);
    }

    // Show next step preview
    if (result.next) {
      console.log(`\n── Next: ${result.next.title} ──────────────────────────────`);
      console.log(`Task: ${result.next.task}`);
      if (result.next.narrative) {
        // Show first line of narrative
        const firstLine = result.next.narrative.trim().split('\n')[0];
        console.log(firstLine);
      }
    }
  }

  process.exit(result.passed ? 0 : 3);
}

async function handleCheckNetworkCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Validate a managed publisher network deployment.

USAGE:
  adcp check-network --url <authoritative-url> [options]
  adcp check-network --domains <domain1,domain2,...> [options]

OPTIONS:
  --url URL           URL of the authoritative adagents.json
  --domains LIST      Comma-separated domains to check
  --concurrency N     Max parallel fetches (default: 10)
  --timeout MS        Per-request timeout in ms (default: 10000)
  --json              Output raw JSON
  --help, -h          Show this help

EXAMPLES:
  adcp check-network --url https://network.example.com/adagents/v2/adagents.json
  adcp check-network --url https://network.example.com/adagents.json --domains extra1.com,extra2.com
  adcp check-network --domains cookingdaily.com,gardenweekly.com
`);
    return;
  }

  const urlIndex = args.indexOf('--url');
  const domainsIndex = args.indexOf('--domains');
  const concurrencyIndex = args.indexOf('--concurrency');
  const timeoutIndex = args.indexOf('--timeout');
  const jsonOutput = args.includes('--json');

  const url = urlIndex !== -1 ? args[urlIndex + 1] : undefined;
  const domainsStr = domainsIndex !== -1 ? args[domainsIndex + 1] : undefined;
  const concurrency = concurrencyIndex !== -1 ? parseInt(args[concurrencyIndex + 1], 10) : undefined;
  const timeout = timeoutIndex !== -1 ? parseInt(args[timeoutIndex + 1], 10) : undefined;

  if (concurrency !== undefined && (isNaN(concurrency) || concurrency < 1)) {
    console.error('ERROR: --concurrency must be a positive integer');
    process.exit(2);
  }
  if (timeout !== undefined && (isNaN(timeout) || timeout < 1)) {
    console.error('ERROR: --timeout must be a positive integer');
    process.exit(2);
  }

  if (!url && !domainsStr) {
    console.error('ERROR: --url or --domains is required\n');
    console.error('Run "adcp check-network --help" for usage');
    process.exit(2);
  }

  const domains = domainsStr
    ? domainsStr
        .split(',')
        .map(d => d.trim())
        .filter(Boolean)
    : undefined;

  const { NetworkConsistencyChecker } = require('../dist/lib/index.js');

  const progressHandler = jsonOutput
    ? undefined
    : ({ phase, completed, total }) => {
        process.stderr.write(`\r  ${phase}: ${completed}/${total}`);
        if (completed === total) process.stderr.write('\n');
      };

  const checker = new NetworkConsistencyChecker({
    authoritativeUrl: url,
    domains,
    concurrency,
    timeoutMs: timeout,
    logLevel: 'warn',
    onProgress: progressHandler,
  });

  try {
    const report = await checker.check();

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.summary.totalIssues > 0 ? 1 : 0);
      return;
    }

    // Pretty-print report
    console.log(`\nNetwork Consistency Report`);
    console.log(`${'='.repeat(50)}`);
    console.log(`Checked at: ${report.checkedAt}`);
    console.log(`Authoritative URL: ${report.authoritativeUrl}`);
    console.log(
      `Coverage: ${(report.coverage * 100).toFixed(1)}% (${report.summary.validPointers}/${report.summary.totalDomains})`
    );

    if (report.schemaErrors.length > 0) {
      console.log(`\nSchema Errors (${report.schemaErrors.length}):`);
      for (const err of report.schemaErrors) {
        console.log(`  - ${err.field}: ${err.message}`);
      }
    }

    if (report.agentHealth.length > 0) {
      console.log(`\nAgent Health:`);
      for (const agent of report.agentHealth) {
        const status = agent.reachable ? 'OK' : 'UNREACHABLE';
        const detail = agent.error ? ` (${agent.error})` : agent.statusCode ? ` (HTTP ${agent.statusCode})` : '';
        console.log(`  ${status} ${agent.url}${detail}`);
      }
    }

    if (report.missingPointers.length > 0) {
      console.log(`\nMissing Pointers (${report.missingPointers.length}):`);
      for (const p of report.missingPointers) {
        console.log(`  - ${p.domain}: ${p.error}`);
      }
    }

    if (report.stalePointers.length > 0) {
      console.log(`\nStale Pointers (${report.stalePointers.length}):`);
      for (const p of report.stalePointers) {
        console.log(`  - ${p.domain}: points to ${p.pointerUrl}, expected ${p.expectedUrl}`);
      }
    }

    if (report.orphanedPointers.length > 0) {
      console.log(`\nOrphaned Pointers (${report.orphanedPointers.length}):`);
      for (const p of report.orphanedPointers) {
        console.log(`  - ${p.domain}: points to ${p.pointerUrl} but not listed in properties`);
      }
    }

    if (report.summary.totalIssues === 0) {
      console.log(`\nAll checks passed.`);
    } else {
      console.log(`\n${report.summary.totalIssues} issue(s) found.`);
    }

    process.exit(report.summary.totalIssues > 0 ? 1 : 0);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(2);
  }
}

// ────────────────────────────────────────────────────────────
// diagnose-auth command
// ────────────────────────────────────────────────────────────

async function handleDiagnoseAuthCommand(args) {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
Diagnose the OAuth handshake for a saved agent or URL.

Use this when: tools/call returns 401/403; a saved token has stopped working;
a refresh succeeds but the next call fails; or you're not sure whether the
agent or your client is at fault.

Probes the RFC 9728 protected-resource metadata, RFC 8414 auth-server metadata,
decodes the saved access token, optionally attempts a refresh with resource
indicator (RFC 8707), and calls tools/list + a tool on the agent. Reports
ranked hypotheses about what's likely wrong.

USAGE:
  adcp diagnose-auth <alias|url> [options]

OPTIONS:
  --json              Emit the full structured report as JSON
  --allow-http        Allow http:// and private-IP targets (dev loops only)
  --skip-refresh      Do not attempt a token refresh
  --skip-tool-call    Do not attempt the authenticated tool_call probe
  --tool NAME         Tool to exercise in the tool_call probe (default: get_products)
  --include-tokens    Include raw access/refresh tokens in JSON output (default: redacted)
  --help, -h          Show this help

EXIT CODES:
  0   No likely failures identified
  1   At least one hypothesis flagged as 'likely'
  2   Usage error (missing arg, invalid flag)

EXAMPLES:
  adcp diagnose-auth myagent
  adcp diagnose-auth myagent --json > diagnosis.json
  adcp diagnose-auth https://agent.example.com/mcp --allow-http
`);
    return;
  }

  const jsonOutput = args.includes('--json');
  const allowPrivateIp = args.includes('--allow-http');
  const skipRefresh = args.includes('--skip-refresh');
  const skipToolCall = args.includes('--skip-tool-call');
  const includeTokens = args.includes('--include-tokens');
  const toolIndex = args.indexOf('--tool');
  let probeToolName;
  if (toolIndex !== -1) {
    const value = args[toolIndex + 1];
    if (!value || value.startsWith('--')) {
      console.error('ERROR: --tool requires a tool name\n');
      process.exit(2);
    }
    probeToolName = value;
  }

  const positional = args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && args[i - 1] === '--tool') return false;
    return true;
  });
  const target = positional[0];
  if (!target) {
    console.error('ERROR: diagnose-auth requires an alias or URL\n');
    console.error('Run "adcp diagnose-auth --help" for usage');
    process.exit(2);
  }

  // Resolve the agent config (alias, built-in, or bare URL). Protocol is fixed
  // to MCP because diagnose-auth exercises MCP-specific wire behavior.
  let agentConfig;
  if (BUILT_IN_AGENTS[target]) {
    const builtIn = BUILT_IN_AGENTS[target];
    agentConfig = {
      id: target,
      name: target,
      agent_uri: builtIn.url,
      protocol: builtIn.protocol || 'mcp',
      auth_token: builtIn.auth_token,
    };
  } else if (isAlias(target)) {
    const saved = getAgent(target);
    agentConfig = {
      id: target,
      name: target,
      agent_uri: saved.url,
      protocol: saved.protocol || 'mcp',
      oauth_tokens: saved.oauth_tokens,
      oauth_client: saved.oauth_client,
      auth_token: saved.auth_token,
    };
  } else if (target.startsWith('http://') || target.startsWith('https://')) {
    agentConfig = {
      id: target,
      name: target,
      agent_uri: target,
      protocol: 'mcp',
    };
  } else {
    console.error(`ERROR: '${target}' is not a valid alias or URL\n`);
    process.exit(2);
  }

  const { runAuthDiagnosis } = require('../dist/lib/auth/oauth/index.js');
  const report = await runAuthDiagnosis(agentConfig, {
    allowPrivateIp,
    skipRefresh,
    skipToolCall,
    probeToolName,
    includeTokens,
  });

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(hasLikelyHypothesis(report) ? 1 : 0);
  }

  renderDiagnosisReport(report);
  process.exit(hasLikelyHypothesis(report) ? 1 : 0);
}

function hasLikelyHypothesis(report) {
  return report.hypotheses.some(h => h.verdict === 'likely');
}

const STEP_LABELS = {
  probe_protected_resource_metadata: 'RFC 9728 protected-resource metadata',
  probe_authorization_server_metadata: 'RFC 8414 authorization-server metadata',
  decode_current_token: 'Decode current access token',
  token_refresh_attempt: 'Refresh grant (RFC 8707 `resource`)',
  decode_refreshed_token: 'Decode refreshed access token',
  list_tools_probe: 'Unauthenticated tools/list probe',
  tool_call_probe: 'Authenticated tool_call probe',
};

function renderDiagnosisReport(report) {
  console.log(`\n🔍 OAuth Diagnosis — ${report.agentUrl}`);
  if (report.aliasId && report.aliasId !== report.agentUrl) {
    console.log(`   Alias: ${report.aliasId}`);
  }
  console.log(`   Generated: ${report.generatedAt}\n`);

  console.log(`WIRE STEPS`);
  for (const step of report.steps) {
    const label = STEP_LABELS[step.name] || step.name;
    const prefix = `  • ${label}`;
    if (step.error) {
      console.log(`${prefix}  ↳ skipped: ${step.error}`);
      continue;
    }
    if (step.http) {
      const statusBadge = step.http.status === 0 ? 'ERR' : `HTTP ${step.http.status}`;
      console.log(`${prefix}  ↳ ${step.http.method} ${step.http.url}  ${statusBadge}`);
      if (step.http.error) console.log(`      error: ${step.http.error}`);
      const wwwAuth = step.http.headers['www-authenticate'];
      if (wwwAuth) console.log(`      WWW-Authenticate: ${wwwAuth}`);
    } else if (step.decodedToken) {
      const audClaim = step.decodedToken.claims.aud;
      const aud = audClaim === undefined ? '(missing)' : JSON.stringify(audClaim);
      const iss = step.decodedToken.claims.iss ?? '(missing)';
      const exp = step.decodedToken.claims.exp;
      const expStr = exp ? new Date(exp * 1000).toISOString() : '(missing)';
      console.log(`${prefix}  ↳ JWT: iss=${iss}  aud=${aud}  exp=${expStr}`);
    } else {
      console.log(`${prefix}  ↳ (no token / opaque token)`);
    }
    if (step.notes) {
      for (const note of step.notes) console.log(`      note: ${note}`);
    }
  }

  console.log(`\nHYPOTHESES (ranked)`);
  for (const h of report.hypotheses) {
    const badge = formatVerdict(h.verdict);
    const id = h.id.padEnd(3);
    console.log(`\n  ${id} ${badge}  ${h.title}`);
    console.log(`       ${h.summary}`);
    for (const ev of h.evidence) console.log(`       · ${ev}`);
  }

  const likely = report.hypotheses.filter(h => h.verdict === 'likely');
  if (likely.length === 0) {
    console.log(`\n✅ No likely failures identified.\n`);
  } else {
    console.log(`\n⚠️  ${likely.length} likely issue(s) identified.\n`);
    console.log(`NEXT STEPS`);
    for (const h of likely) {
      const fix = h.evidence.find(e => e.startsWith('Fix:'));
      if (fix) {
        console.log(`  ${h.id}: ${fix.replace(/^Fix:\s*/, '')}`);
      } else {
        console.log(`  ${h.id}: ${h.summary}`);
      }
    }
    console.log();
  }
}

function formatVerdict(verdict) {
  switch (verdict) {
    case 'likely':
      return '[likely]   ';
    case 'possible':
      return '[possible] ';
    case 'ruled_out':
      return '[ruled-out]';
    default:
      return '[n/a]      ';
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Global: suppress the v2-sunset warning before any subcommand runs.
  // v2 went unsupported on 2026-04-20 (AdCP 3.0 GA, adcp#2220) — the library
  // warns whenever an agent advertises v2 capabilities. The flag is for
  // legacy holdouts who know what they're doing.
  if (args.includes('--allow-v2')) {
    process.env.ADCP_ALLOW_V2 = '1';
  }

  // Handle subcommands before global --help so their own --help works
  if (args[0] === 'registry') {
    const code = await handleRegistryCommand(args.slice(1));
    process.exit(code);
  }

  if (args[0] === 'test') {
    await handleTestCommand(args.slice(1));
    return;
  }

  if (args[0] === 'comply') {
    await handleComplyCommand(args.slice(1));
    return;
  }

  if (args[0] === 'storyboard') {
    await handleStoryboardCommand(args.slice(1));
    return;
  }

  if (args[0] === 'check-network') {
    await handleCheckNetworkCommand(args.slice(1));
    return;
  }

  if (args[0] === 'signing') {
    const { handleSigningCommand } = require('./adcp-signing.js');
    await handleSigningCommand(args.slice(1));
    return;
  }

  if (args[0] === 'grade') {
    const { handleGradeCommand } = require('./adcp-grade.js');
    await handleGradeCommand(args.slice(1));
    return;
  }

  if (args[0] === 'diagnose-auth') {
    await handleDiagnoseAuthCommand(args.slice(1));
    return;
  }

  // `adcp diagnose oauth <alias>` — subcommand alias for `adcp diagnose-auth`.
  // The hyphenated form remains canonical (historical + shorter to type); the
  // subcommand form matches the `<noun> <verb>` convention some docs and
  // tooling expect.
  if (args[0] === 'diagnose' && args[1] === 'oauth') {
    await handleDiagnoseAuthCommand(args.slice(2));
    return;
  }

  // Handle help
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  // Handle agent management commands
  if (args[0] === '--save-auth') {
    // Parse flags first
    const authFlagIndex = args.indexOf('--auth');
    const noAuthFlag = args.includes('--no-auth');
    const oauthFlag = args.includes('--oauth');
    const providedAuthToken = authFlagIndex !== -1 ? args[authFlagIndex + 1] : null;

    // Filter out flags to get positional args
    const saveAuthPositional = args
      .slice(1)
      .filter(arg => arg !== '--auth' && arg !== '--no-auth' && arg !== '--oauth' && arg !== providedAuthToken);

    let alias = saveAuthPositional[0];
    let url = saveAuthPositional[1] || null;
    const protocol = saveAuthPositional[2] || null;

    if (!alias) {
      console.error('ERROR: --save-auth requires an alias\n');
      console.error('Usage: adcp --save-auth <alias> [url] [protocol] [--auth token | --no-auth | --oauth]\n');
      console.error('Example: adcp --save-auth myagent https://agent.example.com --auth your_token\n');
      console.error('         adcp --save-auth myagent https://oauth-server.com/mcp --oauth\n');
      process.exit(2);
    }

    // Check if first arg looks like a URL (common mistake)
    if (alias.startsWith('http://') || alias.startsWith('https://')) {
      console.error('\n⚠️  It looks like you provided a URL without an alias.\n');
      console.error('The --save-auth command requires an alias name first:\n');
      console.error(`  adcp --save-auth <alias> <url>\n`);
      console.error('Example:\n');
      console.error(`  adcp --save-auth myagent ${alias}\n`);
      process.exit(2);
    }

    // Validate flags - only one auth method allowed
    const authMethods = [providedAuthToken !== null, noAuthFlag, oauthFlag].filter(Boolean).length;
    if (authMethods > 1) {
      console.error('ERROR: Cannot use multiple auth methods (--auth, --no-auth, --oauth)\n');
      process.exit(2);
    }

    // Handle OAuth save flow
    if (oauthFlag) {
      if (!url) {
        console.error('ERROR: --oauth requires a URL\n');
        console.error('Usage: adcp --save-auth <alias> <url> --oauth\n');
        process.exit(2);
      }

      // OAuth is only for MCP
      const detectedProtocol = protocol || (url.includes('/mcp') ? 'mcp' : null);
      if (detectedProtocol && detectedProtocol !== 'mcp') {
        console.error('ERROR: OAuth is only supported for MCP protocol\n');
        process.exit(2);
      }

      console.log(`\n🔐 Setting up OAuth for '${alias}'...`);
      console.log(`URL: ${url}\n`);

      // Create a temporary agent config for OAuth
      const tempAgent = {
        id: alias,
        name: alias,
        agent_uri: url,
        protocol: 'mcp',
      };

      const { Client: MCPClient } = require('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');

      const oauthProvider = createCLIOAuthProvider(tempAgent);
      const mcpClient = new MCPClient({ name: 'adcp-cli', version: '1.0.0' });
      const createTransport = () => new StreamableHTTPClientTransport(new URL(url), { authProvider: oauthProvider });

      let transport = createTransport();

      try {
        console.log('Connecting to verify OAuth support...');
        await mcpClient.connect(transport);
        // If we connected without OAuth, the server doesn't require it
        console.log('\n⚠️  Server connected without requiring OAuth.');
        console.log('Saving agent without OAuth tokens.\n');
        await oauthProvider.cleanup();
        await mcpClient.close();
        saveAgent(alias, { url, protocol: 'mcp' });
        console.log(`✅ Agent '${alias}' saved.`);
        console.log(`Use: adcp ${alias} <tool> <payload>\n`);
      } catch (error) {
        if (error instanceof UnauthorizedError || error.name === 'UnauthorizedError') {
          console.log('OAuth authorization required.');
          console.log('Opening browser for authentication...\n');

          try {
            const code = await oauthProvider.waitForCallback();
            console.log('Authorization received!');
            await transport.finishAuth(code);

            // Save agent with OAuth tokens
            const agentConfig = {
              url,
              protocol: 'mcp',
              oauth_tokens: tempAgent.oauth_tokens,
              oauth_client: tempAgent.oauth_client,
            };
            saveAgent(alias, agentConfig);

            console.log(`\n✅ Agent '${alias}' saved with OAuth tokens.`);
            console.log(`Use: adcp ${alias} <tool> <payload>\n`);

            await oauthProvider.cleanup();
            await mcpClient.close();
          } catch (authError) {
            await oauthProvider.cleanup();
            console.error('\n❌ OAuth failed:', authError.message);
            process.exit(1);
          }
        } else {
          await oauthProvider.cleanup();
          console.error('\n❌ Connection failed:', error.message);
          process.exit(1);
        }
      }
      process.exit(0);
    }

    // Determine mode:
    // - If URL provided AND (--auth or --no-auth): fully non-interactive
    // - Otherwise: interactive (prompts for missing values)
    const hasAuthDecision = providedAuthToken !== null || noAuthFlag;
    const nonInteractive = url && hasAuthDecision;

    await interactiveSetup(alias, url, protocol, providedAuthToken, nonInteractive, noAuthFlag);
    process.exit(0);
  }

  if (args[0] === '--list-agents') {
    const agents = listAgents();
    const aliases = Object.keys(agents);

    if (aliases.length === 0) {
      console.log('\nNo saved agents found.');
      console.log('Use: adcp --save-auth <alias> <url>\n');
      process.exit(0);
    }

    console.log('\n📋 Saved Agents:\n');
    aliases.forEach(alias => {
      const agent = agents[alias];
      console.log(`  ${alias}`);
      console.log(`    URL: ${agent.url}`);
      if (agent.protocol) {
        console.log(`    Protocol: ${agent.protocol}`);
      }
      if (agent.auth_token) {
        console.log(`    Auth: token configured`);
      }
      if (agent.oauth_tokens) {
        const hasValid = hasValidOAuthTokens(agent);
        console.log(`    OAuth: ${hasValid ? 'valid tokens' : 'expired (use --oauth to refresh)'}`);
      }
      console.log('');
    });
    console.log(`Config: ${getConfigPath()}\n`);
    process.exit(0);
  }

  if (args[0] === '--remove-agent') {
    const alias = args[1];

    if (!alias) {
      console.error('ERROR: --remove-agent requires an alias\n');
      process.exit(2);
    }

    if (removeAgent(alias)) {
      console.log(`\n✅ Removed agent '${alias}'\n`);
    } else {
      console.error(`\nERROR: Agent '${alias}' not found\n`);
      process.exit(2);
    }
    process.exit(0);
  }

  if (args[0] === '--show-config') {
    console.log(`\nConfig file: ${getConfigPath()}\n`);
    process.exit(0);
  }

  // Handle --clear-oauth command
  if (args.includes('--clear-oauth')) {
    const positionalArgs = args.filter(arg => !arg.startsWith('--'));
    const alias = positionalArgs[0];

    if (!alias) {
      console.error('ERROR: --clear-oauth requires an agent alias\n');
      console.error('Usage: adcp <alias> --clear-oauth\n');
      process.exit(2);
    }

    if (!isAlias(alias)) {
      console.error(`ERROR: '${alias}' is not a saved agent alias\n`);
      process.exit(2);
    }

    const agentConfig = getAgent(alias);
    if (!agentConfig.oauth_tokens) {
      console.log(`\nAgent '${alias}' has no OAuth tokens to clear.\n`);
      process.exit(0);
    }

    // Clear OAuth tokens from agent config
    delete agentConfig.oauth_tokens;
    delete agentConfig.oauth_client;
    delete agentConfig.oauth_code_verifier;
    saveAgent(alias, agentConfig);

    console.log(`\n✅ Cleared OAuth tokens for '${alias}'`);
    console.log('Use --oauth to re-authenticate.\n');
    process.exit(0);
  }

  // Parse arguments
  if (args.length < 1) {
    console.error('ERROR: Missing required arguments\n');
    printUsage();
    process.exit(2);
  }

  // Parse options first
  const authIndex = args.indexOf('--auth');
  let authToken = authIndex !== -1 ? args[authIndex + 1] : process.env.ADCP_AUTH_TOKEN;
  const protocolIndex = args.indexOf('--protocol');
  const protocolFlag = protocolIndex !== -1 ? args[protocolIndex + 1] : null;
  const jsonOutput = args.includes('--json');
  const debug = args.includes('--debug') || process.env.ADCP_DEBUG === 'true';
  const waitForAsync = args.includes('--wait');
  const useLocalWebhook = args.includes('--local');
  const timeoutIndex = args.indexOf('--timeout');
  const timeout = timeoutIndex !== -1 ? parseInt(args[timeoutIndex + 1]) : 300000;
  const useOAuth = args.includes('--oauth');
  const clearOAuth = args.includes('--clear-oauth');

  // Validate protocol flag if provided
  if (protocolFlag && protocolFlag !== 'mcp' && protocolFlag !== 'a2a') {
    console.error(`ERROR: Invalid protocol '${protocolFlag}'. Must be 'mcp' or 'a2a'\n`);
    printUsage();
    process.exit(2);
  }

  // Filter out flag arguments to find positional arguments
  const positionalArgs = args.filter(
    arg =>
      !arg.startsWith('--') &&
      arg !== authToken && // Don't include the auth token value
      arg !== protocolFlag && // Don't include the protocol value
      arg !== (timeoutIndex !== -1 ? args[timeoutIndex + 1] : null) // Don't include timeout value
  );

  // Determine if first arg is alias or URL
  let protocol = protocolFlag; // Start with flag if provided
  let agentUrl;
  let toolName;
  let payloadArg;
  let savedAgent = null;

  const firstArg = positionalArgs[0];

  // Check if first arg is a built-in alias or saved alias
  if (BUILT_IN_AGENTS[firstArg]) {
    // Built-in test helper mode
    savedAgent = BUILT_IN_AGENTS[firstArg];
    agentUrl = savedAgent.url;

    // Protocol priority: --protocol flag > built-in config
    if (!protocol) {
      protocol = savedAgent.protocol;
    }

    toolName = positionalArgs[1];
    payloadArg = positionalArgs[2] || '{}';

    // Use built-in auth token if not overridden and available
    if (!authToken && savedAgent.auth_token) {
      authToken = savedAgent.auth_token;
    }

    if (debug) {
      console.error(`DEBUG: Using built-in agent '${firstArg}'`);
      console.error(`  ${savedAgent.description}`);
      console.error(`  URL: ${agentUrl}`);
      console.error(`  Protocol: ${protocol}`);
      console.error('');
    }
  } else if (isAlias(firstArg)) {
    // Alias mode - load saved agent config
    savedAgent = getAgent(firstArg);
    agentUrl = savedAgent.url;

    // Protocol priority: --protocol flag > saved config > auto-detect
    if (!protocol) {
      protocol = savedAgent.protocol || null;
    }

    toolName = positionalArgs[1];
    payloadArg = positionalArgs[2] || '{}';

    if (!authToken) {
      authToken = getEffectiveAuthToken(savedAgent);
    }

    if (debug) {
      console.error(`DEBUG: Using saved agent '${firstArg}'`);
      console.error(`  URL: ${agentUrl}`);
      if (protocol) {
        console.error(`  Protocol: ${protocol}`);
      }
      console.error('');
    }
  } else if (firstArg && (firstArg.startsWith('http://') || firstArg.startsWith('https://'))) {
    // URL mode
    agentUrl = firstArg;
    toolName = positionalArgs[1];
    payloadArg = positionalArgs[2] || '{}';
    // protocol already set from flag, or null for auto-detect
  } else {
    console.error(`ERROR: First argument must be an alias or URL\n`);
    console.error(`Available aliases: ${Object.keys(listAgents()).join(', ') || 'none'}\n`);
    printUsage();
    process.exit(2);
  }

  // Parse payload
  let payload;
  try {
    if (payloadArg === '-') {
      // Read from stdin
      const stdin = readFileSync(0, 'utf-8');
      payload = JSON.parse(stdin);
    } else if (payloadArg.startsWith('@')) {
      // Read from file
      const filePath = payloadArg.substring(1);
      const fileContent = readFileSync(filePath, 'utf-8');
      payload = JSON.parse(fileContent);
    } else {
      // Parse inline JSON
      payload = JSON.parse(payloadArg);
    }
  } catch (error) {
    console.error(`ERROR: Invalid JSON payload: ${error.message}\n`);
    process.exit(2);
  }

  // Auto-detect protocol if not specified
  if (!protocol) {
    if (debug || !jsonOutput) {
      console.error('🔍 Auto-detecting protocol...');
    }

    try {
      protocol = await detectProtocol(agentUrl);
      if (debug || !jsonOutput) {
        console.error(`✓ Detected protocol: ${protocol.toUpperCase()}\n`);
      }
    } catch (error) {
      console.error(`ERROR: Failed to detect protocol: ${error.message}\n`);
      console.error('Please specify protocol explicitly: adcp mcp <url> or adcp a2a <url>\n');
      process.exit(2);
    }
  }

  if (debug) {
    console.error('DEBUG: Configuration');
    console.error(`  Protocol: ${protocol}`);
    console.error(`  Agent URL: ${agentUrl}`);
    console.error(`  Tool: ${toolName || '(list tools)'}`);
    console.error(`  Auth: ${authToken ? 'provided' : useOAuth ? 'oauth' : 'none'}`);
    console.error(`  Payload: ${JSON.stringify(payload, null, 2)}`);
    console.error('');
  }

  // Check OAuth requirements
  if (useOAuth && protocol !== 'mcp') {
    console.error('\n❌ ERROR: OAuth is only supported for MCP protocol\n');
    console.error('Use --auth TOKEN for A2A protocol authentication.\n');
    process.exit(2);
  }

  // Build agent config
  // If using OAuth with a saved alias, we need to load existing OAuth tokens
  let agentOAuthTokens = null;
  let agentOAuthClient = null;
  let agentAlias = null;

  if (useOAuth && savedAgent && isAlias(firstArg)) {
    agentAlias = firstArg;
    // Reload the full saved config to get OAuth tokens
    const fullSavedConfig = getAgent(firstArg);
    if (fullSavedConfig.oauth_tokens) {
      agentOAuthTokens = fullSavedConfig.oauth_tokens;
      agentOAuthClient = fullSavedConfig.oauth_client;
      if (!jsonOutput && hasValidOAuthTokens({ oauth_tokens: agentOAuthTokens })) {
        console.log('Using saved OAuth tokens...\n');
      }
    }
  }

  // Create agent config
  const agentConfig = {
    id: 'cli-agent',
    name: 'CLI Agent',
    agent_uri: agentUrl,
    protocol: protocol,
    ...(authToken && !useOAuth && { auth_token: authToken, requiresAuth: true }),
    ...(agentOAuthTokens && { oauth_tokens: agentOAuthTokens }),
    ...(agentOAuthClient && { oauth_client: agentOAuthClient }),
  };

  // For saved aliases with OAuth, attach a file-backed storage so the MCP
  // SDK's OAuthProvider can persist refreshed tokens back to the config
  // file. The storage keys writes under the actual alias regardless of the
  // synthetic `cli-agent` id we use in memory.
  if (agentAlias && agentOAuthTokens) {
    const storage = createFileOAuthStorage({
      configPath: getConfigPath(),
      agentKey: agentAlias,
    });
    bindAgentStorage(agentConfig, storage);
  }

  try {
    // If no tool name provided, display agent info
    if (!toolName) {
      if (debug) {
        console.error('DEBUG: No tool specified, displaying agent info...\n');
      }

      // For OAuth without a tool, just authenticate and list tools
      if (useOAuth && protocol === 'mcp') {
        const { Client: MCPClient } = require('@modelcontextprotocol/sdk/client/index.js');
        const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');

        const oauthProvider = createCLIOAuthProvider(agentConfig, { quiet: jsonOutput });
        const mcpClient = new MCPClient({ name: 'adcp-cli', version: '1.0.0' });
        const createTransport = () =>
          new StreamableHTTPClientTransport(new URL(agentUrl), { authProvider: oauthProvider });

        let transport = createTransport();

        try {
          if (!jsonOutput) {
            console.log('Connecting to MCP agent...');
          }
          await mcpClient.connect(transport);
        } catch (error) {
          if (error instanceof UnauthorizedError || error.name === 'UnauthorizedError') {
            if (!jsonOutput) {
              console.log('\nOAuth authorization required.');
              console.log('Opening browser for authentication...\n');
            }
            const code = await oauthProvider.waitForCallback();
            await transport.finishAuth(code);
            if (agentAlias && agentConfig.oauth_tokens) {
              const savedConfig = getAgent(agentAlias);
              savedConfig.oauth_tokens = agentConfig.oauth_tokens;
              savedConfig.oauth_client = agentConfig.oauth_client;
              saveAgent(agentAlias, savedConfig);
              if (!jsonOutput) {
                console.log(`OAuth tokens saved to '${agentAlias}'.\n`);
              }
            }
            transport = createTransport();
            await mcpClient.connect(transport);
          } else {
            await oauthProvider.cleanup();
            throw error;
          }
        }

        if (!jsonOutput) {
          console.log('Connected!\n');
        }

        // List tools
        const toolsResult = await mcpClient.listTools();
        await oauthProvider.cleanup();
        await mcpClient.close();

        if (jsonOutput) {
          console.log(JSON.stringify({ tools: toolsResult.tools, protocol: 'mcp', oauth: true }, null, 2));
        } else {
          console.log(`\n📋 Agent Information (OAuth)\n`);
          console.log(`Protocol: MCP`);
          console.log(`URL: ${agentUrl}`);
          console.log(`\nAvailable Tools (${toolsResult.tools.length}):\n`);
          toolsResult.tools.forEach((tool, i) => {
            console.log(`${i + 1}. ${tool.name}`);
            if (tool.description) {
              console.log(`   ${tool.description}`);
            }
            console.log('');
          });
        }
        process.exit(0);
      }

      await displayAgentInfo(agentConfig, jsonOutput);
      process.exit(0);
    }

    // Set up webhook handler if --wait flag is used
    let webhookHandler = null;
    let webhookUrl = null;

    if (waitForAsync) {
      const useNgrok = !useLocalWebhook;

      // Check if ngrok is available (unless using --local)
      if (useNgrok) {
        const ngrokAvailable = await AsyncWebhookHandler.isNgrokAvailable();
        if (!ngrokAvailable) {
          console.error('\n❌ ERROR: --wait flag requires ngrok to be installed\n');
          console.error('Install ngrok:');
          console.error('  Mac:     brew install ngrok');
          console.error('  Windows: choco install ngrok');
          console.error('  Linux:   Download from https://ngrok.com/download');
          console.error('\nOr use --local flag for local agents (e.g., http://localhost:3000)\n');
          process.exit(2);
        }
      }

      if (debug) {
        console.error(`DEBUG: Setting up ${useNgrok ? 'ngrok' : 'local'} webhook handler...\n`);
      }

      webhookHandler = new AsyncWebhookHandler({
        timeout: timeout,
        debug: debug,
      });

      try {
        webhookUrl = await webhookHandler.start(useNgrok);

        if (!jsonOutput) {
          console.log(`\n🌐 ${useNgrok ? 'Public webhook' : 'Local webhook'} endpoint ready`);
          console.log(`   URL: ${webhookUrl}`);
          console.log(`   Timeout: ${timeout / 1000}s`);
          if (useLocalWebhook) {
            console.log(`   ⚠️  Local mode: Agent must be accessible at localhost`);
          }
          console.log('');
        }
      } catch (error) {
        console.error('\n❌ ERROR: Failed to start webhook handler\n');
        console.error(error.message);
        if (debug) {
          console.error('\nStack trace:');
          console.error(error.stack);
        }
        process.exit(1);
      }
    }

    // Handle OAuth flow for MCP if --oauth is specified
    if (useOAuth && protocol === 'mcp') {
      const { Client: MCPClient } = require('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');

      // Create OAuth provider
      const oauthProvider = createCLIOAuthProvider(agentConfig, {
        quiet: jsonOutput,
      });

      // Create MCP client
      const mcpClient = new MCPClient({
        name: 'adcp-cli',
        version: '1.0.0',
      });

      const createTransport = () =>
        new StreamableHTTPClientTransport(new URL(agentUrl), {
          authProvider: oauthProvider,
        });

      let transport = createTransport();
      let needsOAuth = !hasValidOAuthTokens(agentConfig);

      try {
        if (!jsonOutput) {
          console.log('Connecting to MCP agent...');
        }
        await mcpClient.connect(transport);
      } catch (error) {
        if (error instanceof UnauthorizedError || error.name === 'UnauthorizedError') {
          needsOAuth = true;
          if (!jsonOutput) {
            console.log('\nOAuth authorization required.');
            console.log('Opening browser for authentication...\n');
          }

          try {
            // Wait for user to complete OAuth in browser
            const code = await oauthProvider.waitForCallback();
            if (!jsonOutput) {
              console.log('Authorization received!');
            }

            // Finish OAuth flow
            await transport.finishAuth(code);

            // Save tokens to alias if using a saved agent
            if (agentAlias && agentConfig.oauth_tokens) {
              const savedConfig = getAgent(agentAlias);
              savedConfig.oauth_tokens = agentConfig.oauth_tokens;
              savedConfig.oauth_client = agentConfig.oauth_client;
              saveAgent(agentAlias, savedConfig);
              if (!jsonOutput) {
                console.log(`OAuth tokens saved to '${agentAlias}'.\n`);
              }
            }

            // Reconnect with new tokens
            if (!jsonOutput) {
              console.log('Reconnecting with OAuth tokens...');
            }
            transport = createTransport();
            await mcpClient.connect(transport);
          } catch (authError) {
            await oauthProvider.cleanup();
            throw authError;
          }
        } else {
          await oauthProvider.cleanup();
          throw error;
        }
      }

      if (!jsonOutput) {
        console.log('Connected!\n');
      }

      // Execute tool call directly via MCP
      try {
        const startTime = Date.now();
        const toolResult = await mcpClient.callTool({ name: toolName, arguments: payload });
        const responseTime = Date.now() - startTime;

        await oauthProvider.cleanup();
        await mcpClient.close();

        // Format result similar to AdCPClient response
        let resultData = toolResult;
        if (toolResult.content && Array.isArray(toolResult.content)) {
          const textContent = toolResult.content.find(c => c.type === 'text');
          if (textContent && textContent.text) {
            try {
              resultData = JSON.parse(textContent.text);
            } catch {
              resultData = textContent.text;
            }
          }
        }

        if (jsonOutput) {
          console.log(
            JSON.stringify(
              {
                data: resultData,
                metadata: {
                  protocol: 'mcp',
                  responseTimeMs: responseTime,
                  oauth: true,
                },
              },
              null,
              2
            )
          );
        } else {
          console.log('\n✅ SUCCESS\n');
          console.log('Response:');
          console.log(JSON.stringify(resultData, null, 2));
          console.log('');
          console.log(`Protocol: MCP (OAuth)`);
          console.log(`Response Time: ${responseTime}ms`);
        }
        process.exit(0);
      } catch (toolError) {
        await oauthProvider.cleanup();
        await mcpClient.close();
        throw toolError;
      }
    }

    // Create ADCP client with optional webhook configuration
    // Note: AdCPClient (multi-agent) expects an array of configs
    const client = new AdCPClient([agentConfig], {
      debug: debug,
      ...(webhookUrl && {
        webhookUrlTemplate: webhookUrl,
        webhookSecret: 'cli-webhook-secret',
      }),
    });

    if (debug) {
      console.error('DEBUG: Executing task...\n');
    }

    // Execute the task using the single agent client API
    const agentClient = client.agent('cli-agent');
    const result = await agentClient.executeTask(toolName, payload);

    // If waiting for async response, handle webhook
    if (waitForAsync && webhookHandler) {
      if (result.status === 'submitted' || result.status === 'working') {
        if (!jsonOutput) {
          console.log('📤 Task submitted, waiting for async response...');
        }

        try {
          const webhookResponse = await webhookHandler.waitForResponse();

          // Clean up webhook handler
          await webhookHandler.cleanup();

          // Output webhook response
          if (jsonOutput) {
            console.log(JSON.stringify(webhookResponse.result || webhookResponse, null, 2));
          } else {
            console.log('\n✅ ASYNC RESPONSE RECEIVED\n');
            console.log('Response:');
            console.log(JSON.stringify(webhookResponse.result || webhookResponse, null, 2));
          }

          process.exit(0);
        } catch (error) {
          await webhookHandler.cleanup();
          console.error('\n❌ WEBHOOK TIMEOUT\n');
          console.error(error.message);
          process.exit(3);
        }
      } else {
        // Task completed synchronously, clean up webhook
        await webhookHandler.cleanup();
      }
    }

    // Check for deprecated assets_required usage in list_creative_formats response
    let deprecationWarnings = [];
    if (toolName === 'list_creative_formats' && result.success && result.data) {
      const formats = result.data.formats || result.data;
      const deprecatedFormats = checkDeprecatedFormats(formats);
      if (deprecatedFormats.length > 0) {
        deprecationWarnings.push({
          type: 'assets_required_deprecated',
          message: `⚠️  DEPRECATION: ${deprecatedFormats.length} format(s) using deprecated 'assets_required' field. Please migrate to use 'assets' instead.`,
          formats: deprecatedFormats,
        });
      }
    }

    // Handle result
    if (result.success) {
      if (jsonOutput) {
        // Raw JSON output - include protocol metadata and warnings
        console.log(
          JSON.stringify(
            {
              data: result.data,
              metadata: {
                taskId: result.metadata.taskId,
                protocol: result.metadata.agent.protocol,
                responseTimeMs: result.metadata.responseTimeMs,
                ...(result.conversation &&
                  result.conversation.length > 0 && {
                    protocolMessage: extractProtocolMessage(result.conversation, result.metadata.agent.protocol),
                    contextId: result.metadata.taskId, // Using taskId as context identifier
                  }),
              },
              ...(deprecationWarnings.length > 0 && { warnings: deprecationWarnings }),
            },
            null,
            2
          )
        );
      } else {
        // Pretty output
        console.log('\n✅ SUCCESS\n');

        // Show deprecation warnings if any
        if (deprecationWarnings.length > 0) {
          for (const warning of deprecationWarnings) {
            console.log(warning.message);
            if (warning.formats && warning.formats.length > 0) {
              const displayFormats = warning.formats.slice(0, 5).join(', ');
              const remaining = warning.formats.length - 5;
              console.log(`   Affected formats: ${displayFormats}${remaining > 0 ? `, (+${remaining} more)` : ''}`);
            }
            console.log('');
          }
        }

        // Show protocol message if available
        if (result.conversation && result.conversation.length > 0) {
          const message = extractProtocolMessage(result.conversation, result.metadata.agent.protocol);
          if (message) {
            console.log('Protocol Message:');
            console.log(message);
            console.log('');
          }
        }

        console.log('Response:');
        console.log(JSON.stringify(result.data, null, 2));
        console.log('');
        console.log(`Protocol: ${result.metadata.agent.protocol.toUpperCase()}`);
        console.log(`Response Time: ${result.metadata.responseTimeMs}ms`);
        console.log(`Task ID: ${result.metadata.taskId}`);
        if (result.conversation && result.conversation.length > 0) {
          console.log(`Context ID: ${result.metadata.taskId}`);
        }
      }
      process.exit(0);
    } else {
      console.error('\n❌ TASK FAILED\n');
      console.error(`Error: ${result.error || 'Unknown error'}`);
      if (result.metadata?.clarificationRounds) {
        console.error(`Clarifications: ${result.metadata.clarificationRounds}`);
      }
      if (debug) {
        if (result.metadata) {
          console.error('\nMetadata:');
          console.error(JSON.stringify(result.metadata, null, 2));
        }
        if (result.debug_logs && result.debug_logs.length > 0) {
          console.error('\nDebug Logs:');
          console.error(JSON.stringify(result.debug_logs, null, 2));
        }
        if (result.conversation && result.conversation.length > 0) {
          console.error('\nConversation:');
          console.error(JSON.stringify(result.conversation, null, 2));
        }
      }
      process.exit(3);
    }
  } catch (error) {
    // Defense-in-depth: the library already strips ASCII control chars from
    // server-supplied strings before storing them on `requirements`, but
    // re-apply at the output call site in case a downstream field is added
    // that bypasses the library's sanitizer.
    const safe = s => (typeof s === 'string' ? s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') : s);

    // NeedsAuthorizationError carries walked discovery metadata. Route it
    // through the CLI's existing auto-OAuth flow when conditions are right,
    // so the user gets a browser prompt instead of a cold error message.
    if (error instanceof NeedsAuthorizationError) {
      // Auto-browser requires:
      //   - stdout + stdin are TTYs (the OAuth flow blocks on stdin/terminal focus)
      //   - no explicit opt-out (ADCP_NO_BROWSER) and not in CI
      //   - a protocol we can drive interactively (MCP only today)
      //   - no conflicting auth source already provided
      //   - not asked for JSON (scripts/dashboards must stay deterministic)
      const canAutoBrowse =
        !jsonOutput &&
        !!process.stdout.isTTY &&
        !!process.stdin.isTTY &&
        !process.env.CI &&
        !process.env.ADCP_NO_BROWSER &&
        process.env.TERM !== 'dumb' &&
        protocol === 'mcp' &&
        !useOAuth &&
        !authToken;

      if (!canAutoBrowse) {
        if (jsonOutput) {
          console.log(
            JSON.stringify(
              {
                error: {
                  code: error.code,
                  subCode: error.subCode,
                  message: error.message,
                  requirements: error.requirements,
                },
              },
              null,
              2
            )
          );
        } else {
          console.error('\n🔐 Agent requires OAuth authorization.');
          console.error(`   Authorization server: ${safe(error.requirements.authorizationServer) ?? '(unknown)'}`);
          if (error.requirements.registrationEndpoint) {
            console.error(`   Dynamic client registration: supported`);
          }
          if (error.requirements.scopesSupported?.length) {
            console.error(`   Scopes: ${error.requirements.scopesSupported.map(safe).join(', ')}`);
          }
          if (agentAlias) {
            console.error(`\n   Run: adcp --save-auth ${agentAlias} ${agentUrl} --oauth`);
          } else {
            console.error(`\n   Save the agent with OAuth: adcp --save-auth <alias> ${agentUrl} --oauth`);
          }
          console.error('');
        }
        process.exit(1);
      }

      // Interactive context: print a short header on stderr (so stdout stays
      // clean for the eventual tool result) then fall through to the
      // auto-OAuth branch below which opens the browser and retries the call.
      console.error('\n🔐 Agent requires OAuth authorization.');
      if (error.requirements.authorizationServer) {
        console.error(`   Authorization server: ${safe(error.requirements.authorizationServer)}`);
      }
      if (error.requirements.scopesSupported?.length) {
        console.error(`   Scopes: ${error.requirements.scopesSupported.map(safe).join(', ')}`);
      }
      // Let execution fall through to the auto-OAuth path below.
    }

    // Check if this is an OAuth-required error for MCP and offer auto-authentication.
    // `NeedsAuthorizationError` is the richer form (already extended from
    // AuthenticationRequiredError); the string-match branches cover older
    // error shapes from the MCP SDK and other 401 paths.
    const isUnauthorized =
      error instanceof NeedsAuthorizationError ||
      error.name === 'UnauthorizedError' ||
      error.message?.toLowerCase().includes('unauthorized') ||
      error.message?.includes('401');

    if (isUnauthorized && protocol === 'mcp' && !useOAuth && !authToken) {
      console.log('\n🔐 Server requires authentication.');
      console.log('Starting OAuth authentication...\n');

      // Run OAuth flow automatically
      const { Client: MCPClient } = require('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');

      const oauthProvider = createCLIOAuthProvider(agentConfig, { quiet: jsonOutput });
      const mcpClient = new MCPClient({ name: 'adcp-cli', version: '1.0.0' });
      const createTransport = () =>
        new StreamableHTTPClientTransport(new URL(agentUrl), { authProvider: oauthProvider });

      let transport = createTransport();

      try {
        await mcpClient.connect(transport);
      } catch (connectError) {
        if (connectError instanceof UnauthorizedError || connectError.name === 'UnauthorizedError') {
          console.log('Opening browser for authentication...\n');
          const code = await oauthProvider.waitForCallback();
          console.log('Authorization received!');
          await transport.finishAuth(code);

          // Save tokens if using a saved alias
          if (agentAlias && agentConfig.oauth_tokens) {
            const savedConfig = getAgent(agentAlias);
            savedConfig.oauth_tokens = agentConfig.oauth_tokens;
            savedConfig.oauth_client = agentConfig.oauth_client;
            saveAgent(agentAlias, savedConfig);
            console.log(`OAuth tokens saved to '${agentAlias}'.\n`);
          }

          // Reconnect and execute
          console.log('Reconnecting with OAuth tokens...');
          transport = createTransport();
          await mcpClient.connect(transport);
          console.log('Connected!\n');

          // Execute the tool if specified
          if (toolName) {
            const startTime = Date.now();
            const toolResult = await mcpClient.callTool({ name: toolName, arguments: payload });
            const responseTime = Date.now() - startTime;

            await oauthProvider.cleanup();
            await mcpClient.close();

            let resultData = toolResult;
            if (toolResult.content && Array.isArray(toolResult.content)) {
              const textContent = toolResult.content.find(c => c.type === 'text');
              if (textContent && textContent.text) {
                try {
                  resultData = JSON.parse(textContent.text);
                } catch {
                  resultData = textContent.text;
                }
              }
            }

            if (jsonOutput) {
              console.log(
                JSON.stringify(
                  {
                    data: resultData,
                    metadata: { protocol: 'mcp', responseTimeMs: responseTime, oauth: true },
                  },
                  null,
                  2
                )
              );
            } else {
              console.log('\n✅ SUCCESS\n');
              console.log('Response:');
              console.log(JSON.stringify(resultData, null, 2));
              console.log('');
              console.log(`Protocol: MCP (OAuth)`);
              console.log(`Response Time: ${responseTime}ms`);
            }
            process.exit(0);
          } else {
            // List tools
            const toolsResult = await mcpClient.listTools();
            await oauthProvider.cleanup();
            await mcpClient.close();

            if (jsonOutput) {
              console.log(JSON.stringify({ tools: toolsResult.tools, protocol: 'mcp', oauth: true }, null, 2));
            } else {
              console.log(`\n📋 Agent Information (OAuth)\n`);
              console.log(`Protocol: MCP`);
              console.log(`URL: ${agentUrl}`);
              console.log(`\nAvailable Tools (${toolsResult.tools.length}):\n`);
              toolsResult.tools.forEach((tool, i) => {
                console.log(`${i + 1}. ${tool.name}`);
                if (tool.description) console.log(`   ${tool.description}`);
                console.log('');
              });
            }
            process.exit(0);
          }
        } else {
          await oauthProvider.cleanup();
          throw connectError;
        }
      }
    }

    console.error('\n❌ ERROR\n');
    console.error(error.message);
    if (debug) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Clean up cached MCP connections before exit to avoid hanging
process.on('beforeExit', async () => {
  try {
    const { closeMCPConnections } = require('../dist/lib/protocols/mcp.js');
    await closeMCPConnections();
  } catch {
    /* ignore */
  }
});

main().catch(error => {
  console.error('FATAL ERROR:', error.message);
  process.exit(1);
});
