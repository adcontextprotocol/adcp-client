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
const { readFileSync } = require('fs');
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
const {
  createCLIOAuthProvider,
  hasValidOAuthTokens,
  clearOAuthTokens,
  getEffectiveAuthToken,
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
  // Handle --list-scenarios
  if (args.includes('--list-scenarios') || args.length === 0) {
    console.log('\n📋 Available Test Scenarios:\n');
    const descriptions = {
      health_check: 'Basic connectivity check - verify agent responds',
      discovery: 'Test get_products, list_creative_formats, list_authorized_properties',
      create_media_buy: 'Discovery + create a test media buy (dry-run by default)',
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
  const dryRun = !args.includes('--no-dry-run');
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
    finalAuthToken = finalAuthToken || savedAgent.auth_token;
    // Load OAuth tokens if available and --oauth flag is set
    if (useOAuth && savedAgent.oauth_tokens) {
      if (hasValidOAuthTokens(savedAgent)) {
        oauthTokens = savedAgent.oauth_tokens;
        // Use OAuth access token as bearer token for testing
        if (!finalAuthToken && oauthTokens.access_token) {
          finalAuthToken = oauthTokens.access_token;
        }
      } else {
        // Tokens expired
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
    dry_run: dryRun,
    brief,
    ...(finalAuthToken && { auth: { type: 'bearer', token: finalAuthToken } }),
  };

  if (!jsonOutput) {
    console.log(`\n🧪 Running '${scenario}' tests against ${agentUrl}`);
    console.log(`   Protocol: ${protocol.toUpperCase()}`);
    console.log(`   Dry Run: ${dryRun ? 'Yes (safe mode)' : 'No (real operations)'}`);
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

    // Exit with appropriate code
    process.exit(result.overall_passed ? 0 : 3);
  } catch (error) {
    console.error(`\n❌ Test execution failed: ${error.message}`);
    if (debug) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

function printUsage() {
  console.log(`
AdCP CLI Tool - Direct Agent Communication

USAGE:
  npx @adcp/client <agent-alias|url> [tool-name] [payload] [options]

ARGUMENTS:
  agent-alias|url   Saved agent alias (e.g., 'test-mcp') or full URL to agent endpoint
  tool-name         Name of the tool to call (optional - omit to list available tools)
  payload           JSON payload for the tool (default: {})
                    - Can be inline JSON: '{"brief":"text"}'
                    - Can be file path: @payload.json
                    - Can be stdin: -

OPTIONS:
  --protocol PROTO  Force protocol: 'mcp' or 'a2a' (default: auto-detect)
  --auth TOKEN      Authentication token for the agent
  --oauth           Use OAuth for authentication (MCP only, opens browser)
  --clear-oauth     Clear saved OAuth tokens for an agent
  --wait            Wait for async/webhook responses (requires ngrok or --local)
  --local           Use local webhook without ngrok (for local agents only)
  --timeout MS      Webhook timeout in milliseconds (default: 300000 = 5min)
  --help, -h        Show this help message
  --json            Output raw JSON response (default: pretty print)
  --debug           Show debug information

BUILT-IN TEST AGENTS:
  test-mcp                    AdCP public test agent (MCP, with auth)
  test-a2a                    AdCP public test agent (A2A, with auth)
  test-no-auth                AdCP public test agent (MCP, no auth - demonstrates errors)
  test-a2a-no-auth            AdCP public test agent (A2A, no auth - demonstrates errors)
  creative                    Official AdCP creative agent (MCP only)

AGENT MANAGEMENT:
  --save-auth <alias> [url] [protocol] [--auth token | --no-auth | --oauth]
                              Save agent configuration with an alias name
                              --auth TOKEN: Save with static auth token
                              --no-auth: Save without authentication
                              --oauth: Authenticate via OAuth and save tokens (MCP only)
  --list-agents               List all saved agents
  --remove-agent <alias>      Remove saved agent configuration
  --show-config               Show config file location

AGENT TESTING:
  test <agent> [scenario]     Run test scenarios against an agent
                              Scenarios: discovery, health_check, create_media_buy,
                              full_sales_flow, error_handling, validation, and more
                              Default scenario: discovery
  test --list-scenarios       List all available test scenarios

REGISTRY:
  registry brand <domain>                          Look up a brand
  registry brands <d1> <d2> ...                    Bulk brand lookup
  registry property <domain>                       Look up a property
  registry properties <d1> <d2> ...                Bulk property lookup
  registry save-brand <domain> <name> [manifest]   Save a brand (auth required)
  registry save-property <domain> <agent-url>      Save a property (auth required)
  registry list-brands [--search term]             List/search brands
  registry list-properties [--search term]         List/search properties
  registry search <query>                          Search brands, publishers, properties
  registry agents [--type sales] [--health]        List registered agents
  registry publishers                              List publishers
  registry stats                                   Registry statistics
  registry validate <domain>                       Validate adagents.json
  registry validate-publisher <domain>             Validate publisher config
  registry lookup <domain>                         Look up authorized agents
  registry discover <agent-url>                    Probe live agent endpoint
  registry check-auth <url> <type> <value>         Check property authorization
  registry --help                                  Show full registry help

EXAMPLES:
  # Use built-in test agent (zero config!)
  npx @adcp/client test-mcp
  npx @adcp/client test-mcp get_products '{"brief":"coffee brands"}'
  npx @adcp/client creative list_creative_formats

  # Use built-in test agent with A2A protocol
  npx @adcp/client test-a2a get_products '{"brief":"travel packages"}'

  # Compare authenticated vs unauthenticated (demonstrates auth errors)
  npx @adcp/client test-no-auth get_products '{"brief":"test"}'

  # Non-interactive: save with auth token
  adcp --save-auth myagent https://test-agent.adcontextprotocol.org --auth your_token

  # Non-interactive: save without auth
  adcp --save-auth myagent https://test-agent.adcontextprotocol.org --no-auth

  # Save with OAuth (opens browser, saves tokens)
  adcp --save-auth myagent https://oauth-server.com/mcp --oauth

  # Interactive setup (prompts for URL, protocol, and auth)
  adcp --save-auth myagent

  # Use saved agent alias (auto-detect protocol)
  adcp myagent
  adcp myagent get_products '{"brief":"travel"}'

  # List saved agents
  adcp --list-agents

  # Auto-detect protocol with URL
  adcp https://test-agent.adcontextprotocol.org get_products '{"brief":"coffee"}'

  # Force specific protocol
  adcp https://agent.example.com get_products '{"brief":"coffee"}' --protocol mcp
  adcp myagent list_authorized_properties --protocol a2a

  # Override saved auth token
  adcp myagent get_products '{"brief":"..."}' --auth different-token

  # OAuth authentication (opens browser for login)
  adcp https://oauth-agent.example.com/mcp --oauth
  adcp myagent get_products '{"brief":"..."}' --oauth    # Saves tokens to alias

  # Auto-detect OAuth (automatically starts OAuth if server requires it)
  adcp https://oauth-server.com/mcp get_products '{"brief":"..."}'  # Auto-detects!

  # Clear OAuth tokens and re-authenticate
  adcp myagent --clear-oauth
  adcp myagent --oauth

  # Wait for async response (requires ngrok)
  adcp myagent create_media_buy @payload.json --wait

  # From file or stdin
  adcp myagent create_media_buy @payload.json
  echo '{"brief":"travel"}' | adcp myagent get_products -

  # JSON output for scripting
  adcp myagent get_products '{"brief":"travel"}' --json | jq '.products[0]'

  # Run agent tests
  adcp test test-mcp                      # Test built-in test agent with discovery scenario
  adcp test test-mcp discovery            # Explicit discovery scenario
  adcp test test-mcp full_sales_flow      # Full media buy lifecycle test
  adcp test https://my-agent.com discovery --auth $TOKEN
  adcp test myagent error_handling --json # JSON output for CI
  adcp test --list-scenarios              # Show all available scenarios

  # Registry lookups
  adcp registry brand nike.com
  adcp registry brands nike.com adidas.com coca-cola.com --json
  adcp registry property nytimes.com --auth sk_your_api_key
  adcp registry properties nytimes.com wsj.com

ENVIRONMENT VARIABLES:
  ADCP_AUTH_TOKEN          Default authentication token (overridden by --auth)
  ADCP_REGISTRY_API_KEY    API key for registry lookups
  ADCP_DEBUG               Enable debug mode (set to 'true')

CONFIG FILE:
  Agents are saved to ~/.adcp/config.json

EXIT CODES:
  0   Success
  1   General error
  2   Invalid arguments
  3   Agent error
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Handle registry command (before global --help so registry --help works)
  if (args[0] === 'registry') {
    const code = await handleRegistryCommand(args.slice(1));
    process.exit(code);
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

  // Handle test command (handleTestCommand calls process.exit internally)
  if (args[0] === 'test') {
    await handleTestCommand(args.slice(1));
    return; // handleTestCommand exits, but return for clarity
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

    // Use saved auth token if not overridden
    if (!authToken && savedAgent.auth_token) {
      authToken = savedAgent.auth_token;
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
    // Check if this is an OAuth-required error for MCP and offer auto-authentication
    const isUnauthorized =
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

main().catch(error => {
  console.error('FATAL ERROR:', error.message);
  process.exit(1);
});
