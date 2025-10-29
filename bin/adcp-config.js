/**
 * AdCP CLI Configuration Manager
 *
 * Manages agent aliases and authentication configuration
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.adcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Get the config file path
 */
function getConfigPath() {
  return CONFIG_FILE;
}

/**
 * Ensure config directory exists
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load configuration from disk
 * @returns {Object} Configuration object
 */
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { agents: {}, defaults: {} };
    }

    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Warning: Failed to load config from ${CONFIG_FILE}: ${error.message}`);
    return { agents: {}, defaults: {} };
  }
}

/**
 * Save configuration to disk
 * @param {Object} config Configuration object
 */
function saveConfig(config) {
  try {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch (error) {
    throw new Error(`Failed to save config to ${CONFIG_FILE}: ${error.message}`);
  }
}

/**
 * Get agent configuration by alias
 * @param {string} alias Agent alias
 * @returns {Object|null} Agent config or null if not found
 */
function getAgent(alias) {
  const config = loadConfig();
  return config.agents[alias] || null;
}

/**
 * List all saved agents
 * @returns {Object} Map of alias to agent config
 */
function listAgents() {
  const config = loadConfig();
  return config.agents || {};
}

/**
 * Save an agent configuration
 * @param {string} alias Agent alias
 * @param {Object} agentConfig Agent configuration
 */
function saveAgent(alias, agentConfig) {
  const config = loadConfig();
  if (!config.agents) {
    config.agents = {};
  }

  config.agents[alias] = agentConfig;
  saveConfig(config);
}

/**
 * Remove an agent configuration
 * @param {string} alias Agent alias
 * @returns {boolean} True if agent was removed
 */
function removeAgent(alias) {
  const config = loadConfig();
  if (config.agents && config.agents[alias]) {
    delete config.agents[alias];
    saveConfig(config);
    return true;
  }
  return false;
}

/**
 * Check if a string is an agent alias
 * @param {string} str String to check
 * @returns {boolean} True if string is a saved alias
 */
function isAlias(str) {
  const config = loadConfig();
  return config.agents && config.agents[str] !== undefined;
}

/**
 * Prompt for input securely (for passwords/tokens)
 * @param {string} prompt Prompt message
 * @param {boolean} hidden Hide input (for passwords)
 * @returns {Promise<string>} User input
 */
async function promptSecure(prompt, hidden = true) {
  const readline = require('readline');

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    if (hidden) {
      // Disable echo for password input
      const stdin = process.stdin;
      const originalSetRawMode = stdin.setRawMode;

      // Mute output
      rl.stdoutMuted = true;
      rl._writeToOutput = function _writeToOutput(stringToWrite) {
        if (!rl.stdoutMuted) {
          rl.output.write(stringToWrite);
        }
      };
    }

    rl.question(prompt, (answer) => {
      rl.close();
      if (hidden) {
        console.log(''); // New line after hidden input
      }
      resolve(answer.trim());
    });
  });
}

/**
 * Interactive agent setup
 * @param {string} alias Agent alias
 * @param {string} url Agent URL (optional)
 * @param {string} protocol Protocol (optional)
 * @param {string} authToken Auth token (optional)
 * @param {boolean} nonInteractive Skip prompts if all required args provided
 * @param {boolean} noAuth Explicitly skip auth (--no-auth flag)
 */
async function interactiveSetup(alias, url = null, protocol = null, authToken = null, nonInteractive = false, noAuth = false) {
  // Non-interactive mode: save immediately without prompts
  if (nonInteractive && url) {
    const agentConfig = { url };
    if (protocol) agentConfig.protocol = protocol;
    if (authToken) agentConfig.auth_token = authToken;
    // noAuth flag means explicitly don't save auth

    saveAgent(alias, agentConfig);
    console.log(`\n✅ Agent '${alias}' saved to ${CONFIG_FILE}`);
    console.log(`\nYou can now use: adcp ${alias} <tool> <payload>`);
    return;
  }

  console.log(`\n📝 Setting up agent: ${alias}\n`);

  // Get URL if not provided
  if (!url) {
    url = await promptSecure('Agent URL: ', false);
  }

  // Get protocol if not provided (optional, can auto-detect)
  if (!protocol) {
    const protocolInput = await promptSecure('Protocol (mcp/a2a, or leave blank to auto-detect): ', false);
    protocol = protocolInput || null;
  }

  // Get auth token if not provided and not explicitly disabled
  if (!authToken && !noAuth) {
    process.stdout.write('Auth token (leave blank if not needed): ');
    authToken = await promptSecure('', true);
    authToken = authToken || null;
  }

  // Build config
  const agentConfig = {
    url: url
  };

  if (protocol) {
    agentConfig.protocol = protocol;
  }

  if (authToken) {
    agentConfig.auth_token = authToken;
  }

  // Save
  saveAgent(alias, agentConfig);

  console.log(`\n✅ Agent '${alias}' saved to ${CONFIG_FILE}`);
  console.log(`\nYou can now use: adcp ${alias} <tool> <payload>`);
}

module.exports = {
  getConfigPath,
  loadConfig,
  saveConfig,
  getAgent,
  listAgents,
  saveAgent,
  removeAgent,
  isAlias,
  promptSecure,
  interactiveSetup
};
