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

const { ADCPClient } = require('../dist/lib/index.js');
const { readFileSync } = require('fs');
const { AsyncWebhookHandler } = require('./adcp-async-handler.js');

/**
 * Create a promise that rejects after a timeout
 * @param {number} ms - Timeout in milliseconds
 * @returns {Promise<never>}
 */
function createTimeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
  });
}

/**
 * Normalize agent card URL by removing trailing slash and adding agent card path
 * @param {string} agentUrl - Base agent URL
 * @returns {string} Normalized agent card URL
 */
function normalizeAgentCardUrl(agentUrl) {
  if (agentUrl.endsWith('/.well-known/agent-card.json')) {
    return agentUrl;
  }
  return agentUrl.replace(/\/$/, '') + '/.well-known/agent-card.json';
}

/**
 * Auto-detect protocol by testing if agent responds to A2A or MCP
 * Tries A2A first (agent card lookup), then MCP (endpoint connection)
 *
 * @param {string} agentUrl - URL to test
 * @param {string} authToken - Optional auth token
 * @param {boolean} debug - Enable debug logging
 * @returns {Promise<'a2a' | 'mcp'>} Detected protocol
 */
async function detectProtocol(agentUrl, authToken, debug) {
  if (!debug) {
    console.error('🔍 Auto-detecting protocol...');
  }

  // Test A2A first (faster - just needs agent card)
  // Timeout after 5 seconds to avoid hanging on unresponsive servers
  try {
    const clientModule = require('@a2a-js/sdk/client');
    const A2AClient = clientModule.A2AClient;

    const fetchImpl = authToken ? async (url, options) => {
      const headers = {
        ...options?.headers,
        'Authorization': `Bearer ${authToken}`,
        'x-adcp-auth': authToken
      };
      return fetch(url, { ...options, headers });
    } : undefined;

    const cardUrl = normalizeAgentCardUrl(agentUrl);

    const a2aDetection = (async () => {
      const client = await A2AClient.fromCardUrl(cardUrl, fetchImpl ? { fetchImpl } : {});
      const agentCard = client.agentCardPromise ? await client.agentCardPromise : client.agentCard;
      return agentCard;
    })();

    const agentCard = await Promise.race([a2aDetection, createTimeout(5000)]);

    if (agentCard && (agentCard.skills || agentCard.name)) {
      if (debug) {
        console.error('DEBUG: A2A agent card found');
      } else {
        console.error('✓ Detected protocol: A2A\n');
      }
      return 'a2a';
    }
  } catch (error) {
    if (debug) {
      console.error(`DEBUG: A2A detection failed: ${error.message}`);
    }
  }

  // Test MCP (try both with and without /mcp suffix)
  // Timeout after 5 seconds per endpoint to avoid hanging
  try {
    const { Client: MCPClient } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

    const customFetch = authToken ? async (input, init) => {
      const headers = {
        ...init?.headers,
        'Authorization': `Bearer ${authToken}`,
        'x-adcp-auth': authToken
      };
      return fetch(input, { ...init, headers });
    } : undefined;

    const testMcpEndpoint = async (url) => {
      try {
        const mcpClient = new MCPClient({
          name: 'AdCP-Client',
          version: '1.0.0'
        });

        const transport = new StreamableHTTPClientTransport(
          new URL(url),
          customFetch ? { fetch: customFetch } : {}
        );

        const mcpTest = (async () => {
          await mcpClient.connect(transport);
          try {
            await mcpClient.close();
          } catch (closeError) {
            // Ignore close errors - connection succeeded which is what matters
            if (debug) {
              console.error(`DEBUG: MCP close error ignored: ${closeError.message}`);
            }
          }
        })();

        await Promise.race([mcpTest, createTimeout(5000)]);
        return true;
      } catch {
        return false;
      }
    };

    const cleanUrl = agentUrl.replace(/\/$/, '');

    // Test provided URL first
    if (await testMcpEndpoint(cleanUrl)) {
      if (debug) {
        console.error(`DEBUG: MCP endpoint found at ${cleanUrl}`);
      } else {
        console.error('✓ Detected protocol: MCP\n');
      }
      return 'mcp';
    }

    // Try with /mcp suffix
    const withMcp = cleanUrl + '/mcp';
    if (await testMcpEndpoint(withMcp)) {
      if (debug) {
        console.error(`DEBUG: MCP endpoint found at ${withMcp}`);
      } else {
        console.error('✓ Detected protocol: MCP\n');
      }
      return 'mcp';
    }
  } catch (error) {
    if (debug) {
      console.error(`DEBUG: MCP detection failed: ${error.message}`);
    }
  }

  const errorMessage = [
    `Could not detect protocol at ${agentUrl}`,
    `Tried:`,
    `  - A2A agent card at ${agentUrl}/.well-known/agent-card.json`,
    `  - MCP endpoint at ${agentUrl}`,
    `  - MCP endpoint at ${agentUrl}/mcp`,
    `Please specify protocol explicitly: 'adcp mcp <url>' or 'adcp a2a <url>'`
  ].join('\n');

  throw new Error(errorMessage);
}

/**
 * Display agent info - just calls library method
 */
async function displayAgentInfo(agentConfig, jsonOutput) {
  const client = new ADCPClient(agentConfig);
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
  adcp [protocol] <agent-url> [tool-name] [payload] [options]

ARGUMENTS:
  protocol      (Optional) Protocol to use: 'mcp' or 'a2a'
                If omitted, protocol will be auto-detected
  agent-url     Full URL to the agent endpoint
  tool-name     Name of the tool to call (optional - omit to list available tools)
  payload       JSON payload for the tool (default: {})
                - Can be inline JSON: '{"brief":"text"}'
                - Can be file path: @payload.json
                - Can be stdin: -

OPTIONS:
  --protocol PROTO  Force protocol: 'mcp' or 'a2a' (skips auto-detection)
  --auth TOKEN      Authentication token for the agent
  --wait            Wait for async/webhook responses (requires ngrok or --local)
  --local           Use local webhook without ngrok (for local agents only)
  --timeout MS      Webhook timeout in milliseconds (default: 300000 = 5min)
  --help, -h        Show this help message
  --json            Output raw JSON response (default: pretty print)
  --debug           Show debug information

EXAMPLES:
  # Auto-detect protocol and list available tools
  adcp https://test-agent.adcontextprotocol.org

  # Explicit protocol (positional)
  adcp mcp https://agent.example.com/mcp
  adcp a2a https://creative.adcontextprotocol.org

  # Explicit protocol (flag) - useful when you need other options
  adcp --protocol mcp https://agent.example.com/mcp
  adcp --protocol a2a https://agent.example.com --auth $TOKEN

  # Auto-detect with tool execution
  adcp https://agent.example.com get_products '{"brief":"coffee brands"}'

  # Simple product discovery with explicit protocol
  adcp mcp https://agent.example.com/mcp get_products '{"brief":"coffee brands"}'

  # With authentication
  adcp a2a https://agent.example.com list_creative_formats '{}' --auth your_token

  # Wait for async response (requires ngrok)
  adcp mcp https://agent.example.com/mcp create_media_buy @payload.json --auth $TOKEN --wait

  # Wait for async response from local agent (no ngrok needed)
  adcp mcp http://localhost:3000/mcp create_media_buy @payload.json --wait --local

  # From file
  adcp mcp https://agent.example.com/mcp create_media_buy @payload.json --auth $TOKEN

  # From stdin
  echo '{"brief":"travel"}' | adcp mcp https://agent.example.com/mcp get_products -

ENVIRONMENT VARIABLES:
  ADCP_AUTH_TOKEN    Default authentication token (overridden by --auth)
  ADCP_DEBUG         Enable debug mode (set to 'true')

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

  // Parse options first
  const authIndex = args.indexOf('--auth');
  const authToken = authIndex !== -1 ? args[authIndex + 1] : process.env.ADCP_AUTH_TOKEN;
  const protocolIndex = args.indexOf('--protocol');
  const protocolOverride = protocolIndex !== -1 ? args[protocolIndex + 1] : null;
  const jsonOutput = args.includes('--json');
  const debug = args.includes('--debug') || process.env.ADCP_DEBUG === 'true';
  const waitForAsync = args.includes('--wait');
  const useLocalWebhook = args.includes('--local');
  const timeoutIndex = args.indexOf('--timeout');
  const timeout = timeoutIndex !== -1 ? parseInt(args[timeoutIndex + 1]) : 300000;

  // Filter out flag arguments to find positional arguments
  const positionalArgs = args.filter(arg =>
    !arg.startsWith('--') &&
    arg !== authToken && // Don't include the auth token value
    arg !== protocolOverride && // Don't include the protocol value
    arg !== (timeoutIndex !== -1 ? args[timeoutIndex + 1] : null) // Don't include timeout value
  );

  // Parse arguments - handle multiple formats:
  // 1. adcp <url> [tool] [payload] (auto-detect protocol)
  // 2. adcp <protocol> <url> [tool] [payload] (explicit protocol as positional arg)
  // 3. adcp --protocol <protocol> <url> [tool] [payload] (explicit protocol as flag)
  if (positionalArgs.length < 1) {
    console.error('ERROR: Missing required arguments\n');
    printUsage();
    process.exit(2);
  }

  // Check if --protocol flag was used
  if (protocolOverride) {
    if (protocolOverride !== 'mcp' && protocolOverride !== 'a2a') {
      console.error(`ERROR: Invalid protocol '${protocolOverride}'. Must be 'mcp' or 'a2a'\n`);
      printUsage();
      process.exit(2);
    }
  }

  // Detect if first arg is a URL or protocol
  const firstArg = positionalArgs[0];
  const isFirstArgUrl = firstArg.startsWith('http://') || firstArg.startsWith('https://');

  let protocol;
  let agentUrl;
  let toolName;
  let payloadArg;

  if (protocolOverride) {
    // Format: adcp --protocol <protocol> <url> [tool] [payload]
    protocol = protocolOverride;
    agentUrl = positionalArgs[0];
    toolName = positionalArgs[1];
    payloadArg = positionalArgs[2] || '{}';
  } else if (isFirstArgUrl) {
    // Format: adcp <url> [tool] [payload]
    agentUrl = positionalArgs[0];
    toolName = positionalArgs[1];
    payloadArg = positionalArgs[2] || '{}';

    // Auto-detect protocol
    try {
      protocol = await detectProtocol(agentUrl, authToken, debug);
    } catch (error) {
      console.error(`\n❌ ERROR\n`);
      console.error(error.message);
      process.exit(1);
    }
  } else {
    // Format: adcp <protocol> <url> [tool] [payload]
    if (positionalArgs.length < 2) {
      console.error('ERROR: Missing agent URL\n');
      printUsage();
      process.exit(2);
    }

    protocol = positionalArgs[0];
    agentUrl = positionalArgs[1];
    toolName = positionalArgs[2];
    payloadArg = positionalArgs[3] || '{}';

    // Validate protocol
    if (protocol !== 'mcp' && protocol !== 'a2a') {
      console.error(`ERROR: Invalid protocol '${protocol}'. Must be 'mcp' or 'a2a'\n`);
      printUsage();
      process.exit(2);
    }
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

  if (debug) {
    console.error('DEBUG: Configuration');
    console.error(`  Protocol: ${protocol}`);
    console.error(`  Agent URL: ${agentUrl}`);
    console.error(`  Tool: ${toolName}`);
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
    ...(authToken && { auth_token_env: authToken })
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
        debug: debug
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
    const client = new ADCPClient(agentConfig, {
      debug: debug,
      ...(webhookUrl && {
        webhookUrlTemplate: webhookUrl,
        webhookSecret: 'cli-webhook-secret'
      })
    });

    if (debug) {
      console.error('DEBUG: Executing task...\n');
    }

    // Execute the task
    const result = await client.executeTask(toolName, payload);

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
        // Raw JSON output
        console.log(JSON.stringify(result.data, null, 2));
      } else {
        // Pretty output
        console.log('\n✅ SUCCESS\n');
        console.log('Response:');
        console.log(JSON.stringify(result.data, null, 2));
        console.log('');
        console.log(`Response Time: ${result.metadata.responseTimeMs}ms`);
        console.log(`Task ID: ${result.metadata.taskId}`);
      }
      process.exit(0);
    } else {
      console.error('\n❌ TASK FAILED\n');
      console.error(`Error: ${result.error || 'Unknown error'}`);
      if (result.metadata?.clarificationRounds) {
        console.error(`Clarifications: ${result.metadata.clarificationRounds}`);
      }
      if (debug && result.metadata) {
        console.error('\nMetadata:');
        console.error(JSON.stringify(result.metadata, null, 2));
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
