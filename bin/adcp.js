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

const { AdCPClient, detectProtocol } = require('../dist/lib/index.js');
const { readFileSync } = require('fs');
const { AsyncWebhookHandler } = require('./adcp-async-handler.js');
const { getAgent, listAgents, isAlias, interactiveSetup, removeAgent, getConfigPath } = require('./adcp-config.js');

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
 * Display agent info - just calls library method
 */
async function displayAgentInfo(agentConfig, jsonOutput) {
  const client = new AdCPClient(agentConfig);
  const info = await client.getAgentInfo();

  if (jsonOutput) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    console.log(`\n📋 Agent Information\n`);
    console.log(`Name: ${info.name}`);
    if (info.description) {
      console.log(`Description: ${info.description}`);
    }
    console.log(`Protocol: ${info.protocol.toUpperCase()}`);
    console.log(`URL: ${info.url}`);
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

function printUsage() {
  console.log(`
AdCP CLI Tool - Direct Agent Communication

USAGE:
  npx @adcp/client <agent-alias|url> [tool-name] [payload] [options]

ARGUMENTS:
  agent-alias|url   Saved agent alias (e.g., 'test') or full URL to agent endpoint
  tool-name         Name of the tool to call (optional - omit to list available tools)
  payload           JSON payload for the tool (default: {})
                    - Can be inline JSON: '{"brief":"text"}'
                    - Can be file path: @payload.json
                    - Can be stdin: -

OPTIONS:
  --protocol PROTO  Force protocol: 'mcp' or 'a2a' (default: auto-detect)
  --auth TOKEN      Authentication token for the agent
  --wait            Wait for async/webhook responses (requires ngrok or --local)
  --local           Use local webhook without ngrok (for local agents only)
  --timeout MS      Webhook timeout in milliseconds (default: 300000 = 5min)
  --help, -h        Show this help message
  --json            Output raw JSON response (default: pretty print)
  --debug           Show debug information

BUILT-IN TEST AGENTS:
  test                        AdCP public test agent (MCP, with auth)
  test-a2a                    AdCP public test agent (A2A, with auth)
  test-no-auth                AdCP public test agent (MCP, no auth - demonstrates errors)
  test-a2a-no-auth            AdCP public test agent (A2A, no auth - demonstrates errors)
  creative                    Official AdCP creative agent (MCP only)

AGENT MANAGEMENT:
  --save-auth <alias> [url] [protocol] [--auth token | --no-auth]
                              Save agent configuration with an alias name
                              Requires --auth or --no-auth for non-interactive mode
  --list-agents               List all saved agents
  --remove-agent <alias>      Remove saved agent configuration
  --show-config               Show config file location

EXAMPLES:
  # Use built-in test agent (zero config!)
  npx @adcp/client test
  npx @adcp/client test get_products '{"brief":"coffee brands"}'
  npx @adcp/client creative list_creative_formats

  # Use built-in test agent with A2A protocol
  npx @adcp/client test-a2a get_products '{"brief":"travel packages"}'

  # Compare authenticated vs unauthenticated (demonstrates auth errors)
  npx @adcp/client test-no-auth get_products '{"brief":"test"}'

  # Non-interactive: save with auth token
  adcp --save-auth myagent https://test-agent.adcontextprotocol.org --auth your_token

  # Non-interactive: save without auth
  adcp --save-auth myagent https://test-agent.adcontextprotocol.org --no-auth

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

  # Wait for async response (requires ngrok)
  adcp myagent create_media_buy @payload.json --wait

  # From file or stdin
  adcp myagent create_media_buy @payload.json
  echo '{"brief":"travel"}' | adcp myagent get_products -

  # JSON output for scripting
  adcp myagent get_products '{"brief":"travel"}' --json | jq '.products[0]'

ENVIRONMENT VARIABLES:
  ADCP_AUTH_TOKEN    Default authentication token (overridden by --auth)
  ADCP_DEBUG         Enable debug mode (set to 'true')

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
    const providedAuthToken = authFlagIndex !== -1 ? args[authFlagIndex + 1] : null;

    // Filter out flags to get positional args
    const saveAuthPositional = args
      .slice(1)
      .filter(arg => arg !== '--auth' && arg !== '--no-auth' && arg !== providedAuthToken);

    let alias = saveAuthPositional[0];
    let url = saveAuthPositional[1] || null;
    const protocol = saveAuthPositional[2] || null;

    if (!alias) {
      console.error('ERROR: --save-auth requires an alias\n');
      console.error('Usage: adcp --save-auth <alias> [url] [protocol] [--auth token | --no-auth]\n');
      console.error('Example: adcp --save-auth myagent https://agent.example.com --auth your_token\n');
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

    // Validate flags
    if (providedAuthToken && noAuthFlag) {
      console.error('ERROR: Cannot use both --auth and --no-auth\n');
      process.exit(2);
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
        console.log(`    Auth: configured`);
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

  // Built-in test helper aliases
  const BUILT_IN_AGENTS = {
    test: {
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
      description: 'AdCP public test agent (MCP, no auth - demonstrates auth errors)',
    },
    'test-a2a-no-auth': {
      url: 'https://test-agent.adcontextprotocol.org',
      protocol: 'a2a',
      description: 'AdCP public test agent (A2A, no auth - demonstrates auth errors)',
    },
    creative: {
      url: 'https://creative.adcontextprotocol.org/mcp',
      protocol: 'mcp',
      description: 'Official AdCP creative agent (MCP only)',
    },
  };

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
    console.error(`  Auth: ${authToken ? 'provided' : 'none'}`);
    console.error(`  Payload: ${JSON.stringify(payload, null, 2)}`);
    console.error('');
  }

  // Create agent config
  const agentConfig = {
    id: 'cli-agent',
    name: 'CLI Agent',
    agent_uri: agentUrl,
    protocol: protocol,
    ...(authToken && { auth_token_env: authToken, requiresAuth: true }),
  };

  try {
    // If no tool name provided, display agent info
    if (!toolName) {
      if (debug) {
        console.error('DEBUG: No tool specified, displaying agent info...\n');
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

    // Handle result
    if (result.success) {
      if (jsonOutput) {
        // Raw JSON output - include protocol metadata
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
            },
            null,
            2
          )
        );
      } else {
        // Pretty output
        console.log('\n✅ SUCCESS\n');

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
