#!/usr/bin/env node

/**
 * Async webhook handler for AdCP CLI
 *
 * This module handles async/webhook responses by:
 * 1. Starting a temporary HTTP server for webhooks
 * 2. Using ngrok to expose the server publicly (if available)
 * 3. Waiting for the async response
 */

const http = require('http');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

class AsyncWebhookHandler {
  constructor(options = {}) {
    this.port = options.port || 0; // 0 = random available port
    this.timeout = options.timeout || 300000; // 5 minutes default
    this.debug = options.debug || false;
    this.server = null;
    this.ngrokProcess = null;
    this.webhookUrl = null;
    this.operationId = randomUUID();
    this.responsePromise = null;
    this.responseResolver = null;
  }

  /**
   * Check if ngrok is installed
   */
  static isNgrokAvailable() {
    return new Promise(resolve => {
      const check = spawn('which', ['ngrok']);
      check.on('close', code => resolve(code === 0));
    });
  }

  /**
   * Start the webhook server and optionally ngrok tunnel
   * @param {boolean} useNgrok - Whether to use ngrok (default: true)
   */
  async start(useNgrok = true) {
    // Create the promise that will resolve when we get the webhook
    this.responsePromise = new Promise((resolve, reject) => {
      this.responseResolver = resolve;
      this.responseRejector = reject;

      // Set timeout
      setTimeout(() => {
        reject(new Error(`Webhook timeout after ${this.timeout}ms`));
      }, this.timeout);
    });

    // Start HTTP server
    await this.startServer();

    if (useNgrok) {
      // Start ngrok tunnel
      const ngrokAvailable = await AsyncWebhookHandler.isNgrokAvailable();
      if (ngrokAvailable) {
        await this.startNgrok();
      } else {
        throw new Error(
          'ngrok is not installed. Install it with: brew install ngrok (Mac) or download from https://ngrok.com'
        );
      }
    } else {
      // Use local URL (for local agents)
      this.webhookUrl = `http://localhost:${this.port}`;

      if (this.debug) {
        console.error(`✅ Local webhook server ready: ${this.webhookUrl}`);
      }
    }

    return this.webhookUrl;
  }

  /**
   * Start the HTTP server
   */
  startServer() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST') {
          let body = '';

          req.on('data', chunk => {
            body += chunk.toString();
          });

          req.on('end', () => {
            try {
              const payload = JSON.parse(body);

              if (this.debug) {
                console.error('\n🎣 Webhook received:');
                console.error(JSON.stringify(payload, null, 2));
              }

              // Send 202 Accepted response
              res.writeHead(202, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'accepted' }));

              // Resolve the promise with the webhook payload
              if (this.responseResolver) {
                this.responseResolver(payload);
              }
            } catch (error) {
              if (this.debug) {
                console.error('Error parsing webhook:', error);
              }
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
          });
        } else {
          // Health check endpoint
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ready', operation_id: this.operationId }));
        }
      });

      this.server.listen(this.port, () => {
        const address = this.server.address();
        this.port = address.port;

        if (this.debug) {
          console.error(`✅ Webhook server listening on port ${this.port}`);
        }

        resolve();
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Start ngrok tunnel
   */
  startNgrok() {
    return new Promise((resolve, reject) => {
      if (this.debug) {
        console.error(`🚇 Starting ngrok tunnel for port ${this.port}...`);
      }

      // Start ngrok with JSON output for easier parsing
      this.ngrokProcess = spawn('ngrok', ['http', String(this.port), '--log=stdout', '--log-format=json']);

      let ngrokStarted = false;
      let buffer = '';

      this.ngrokProcess.stdout.on('data', data => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line);

            // Look for the tunnel URL in ngrok's JSON output
            if (parsed.url && parsed.url.startsWith('https://')) {
              this.webhookUrl = parsed.url;
              ngrokStarted = true;

              if (this.debug) {
                console.error(`✅ ngrok tunnel ready: ${this.webhookUrl}`);
              }

              resolve();
            }
          } catch (e) {
            // Not JSON, might be plain text output
            // Try to extract URL from plain text
            const urlMatch = line.match(/https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/);
            if (urlMatch && !ngrokStarted) {
              this.webhookUrl = urlMatch[0];
              ngrokStarted = true;

              if (this.debug) {
                console.error(`✅ ngrok tunnel ready: ${this.webhookUrl}`);
              }

              resolve();
            }
          }
        }
      });

      this.ngrokProcess.stderr.on('data', data => {
        if (this.debug) {
          console.error('ngrok stderr:', data.toString());
        }
      });

      this.ngrokProcess.on('error', error => {
        reject(new Error(`Failed to start ngrok: ${error.message}`));
      });

      this.ngrokProcess.on('close', code => {
        if (!ngrokStarted && code !== 0) {
          reject(new Error(`ngrok exited with code ${code}`));
        }
      });

      // Timeout for ngrok startup
      setTimeout(() => {
        if (!ngrokStarted) {
          reject(new Error('ngrok failed to start within 10 seconds'));
        }
      }, 10000);
    });
  }

  /**
   * Wait for the webhook response
   */
  async waitForResponse() {
    if (this.debug) {
      console.error('\n⏳ Waiting for async response...');
    }

    const startTime = Date.now();
    const result = await this.responsePromise;
    const duration = Date.now() - startTime;

    if (this.debug) {
      console.error(`✅ Response received after ${(duration / 1000).toFixed(1)}s\n`);
    }

    return result;
  }

  /**
   * Clean up resources
   */
  async cleanup() {
    if (this.debug) {
      console.error('🧹 Cleaning up...');
    }

    // Close HTTP server
    if (this.server) {
      await new Promise(resolve => {
        this.server.close(() => resolve());
      });
    }

    // Kill ngrok process
    if (this.ngrokProcess) {
      this.ngrokProcess.kill();
    }

    if (this.debug) {
      console.error('✅ Cleanup complete');
    }
  }

  /**
   * Get the webhook URL with operation ID
   */
  getWebhookUrl() {
    if (!this.webhookUrl) {
      throw new Error('Webhook server not started');
    }
    return `${this.webhookUrl}?operation_id=${this.operationId}`;
  }
}

module.exports = { AsyncWebhookHandler };
