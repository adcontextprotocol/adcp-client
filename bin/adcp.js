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
  adcp <protocol> <agent-url> [tool-name] [payload] [options]

ARGUMENTS:
  protocol      Protocol to use: 'mcp' or 'a2a'
  agent-url     Full URL to the agent endpoint
  tool-name     Name of the tool to call (optional - omit to list available tools)
  payload       JSON payload for the tool (default: {})
                - Can be inline JSON: '{"brief":"text"}'
                - Can be file path: @payload.json
                - Can be stdin: -

OPTIONS:
  --auth TOKEN    Authentication token for the agent
  --wait          Wait for async/webhook responses (requires ngrok or --local)
  --local         Use local webhook without ngrok (for local agents only)
  --timeout MS    Webhook timeout in milliseconds (default: 300000 = 5min)
  --help, -h      Show this help message
  --json          Output raw JSON response (default: pretty print)
  --debug         Show debug information

EXAMPLES:
  # List available tools
  adcp mcp https://agent.example.com/mcp
  adcp a2a https://creative.adcontextprotocol.org

  # Simple product discovery
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

  // Parse arguments
  if (args.length < 2) {
    console.error('ERROR: Missing required arguments\n');
    printUsage();
    process.exit(2);
  }

  // Parse options first
  const authIndex = args.indexOf('--auth');
  const authToken = authIndex !== -1 ? args[authIndex + 1] : process.env.ADCP_AUTH_TOKEN;
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
    arg !== (timeoutIndex !== -1 ? args[timeoutIndex + 1] : null) // Don't include timeout value
  );

  const protocol = positionalArgs[0];
  const agentUrl = positionalArgs[1];
  const toolName = positionalArgs[2]; // Optional - if not provided, list tools
  let payloadArg = positionalArgs[3] || '{}';

  // Validate protocol
  if (protocol !== 'mcp' && protocol !== 'a2a') {
    console.error(`ERROR: Invalid protocol '${protocol}'. Must be 'mcp' or 'a2a'\n`);
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
