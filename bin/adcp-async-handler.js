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
const { createHmac, randomUUID, timingSafeEqual } = require('crypto');

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

class AsyncWebhookHandler {
  constructor(options = {}) {
    this.port = options.port || 0; // 0 = random available port
    this.timeout = options.timeout || 300000; // 5 minutes default
    this.debug = options.debug || false;
    this.server = null;
    this.ngrokProcess = null;
    this.webhookUrl = null;
    this.operationId = randomUUID();
    this.webhookSecret = options.webhookSecret;
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
      this.timeoutHandle = setTimeout(() => {
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

    return this.getWebhookUrl();
  }

  /**
   * Start the HTTP server
   */
  startServer() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const requestUrl = new URL(req.url || '/', 'http://localhost');
        const operationMatches = requestUrl.searchParams.get('op') === this.operationId;

        if (req.method === 'POST' && operationMatches) {
          const contentLength = Number(req.headers['content-length']);
          if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
            return;
          }

          let body = '';
          let bodyBytes = 0;

          req.setTimeout(WEBHOOK_REQUEST_TIMEOUT_MS, () => {
            if (!res.headersSent) {
              res.writeHead(408, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Request timeout' }));
            }
            req.destroy();
          });

          req.on('data', chunk => {
            bodyBytes += chunk.length;
            if (bodyBytes > MAX_WEBHOOK_BODY_BYTES) {
              if (!res.headersSent) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Payload too large' }));
              }
              req.destroy();
              return;
            }
            body += chunk.toString();
          });

          req.on('end', () => {
            if (bodyBytes > MAX_WEBHOOK_BODY_BYTES || res.headersSent) return;
            try {
              if (!this.verifyHmac(req.headers, body)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid webhook signature' }));
                return;
              }

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
                clearTimeout(this.timeoutHandle);
                this.responseResolver(payload);
                this.responseResolver = null;
              }
            } catch (error) {
              if (this.debug) {
                console.error('Error parsing webhook:', error);
              }
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
          });
        } else if (req.method === 'GET') {
          // Health checks intentionally do not disclose the operation token.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ready' }));
        } else {
          // A non-matching POST must not settle the pending operation.
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
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

  verifyHmac(headers, rawBody) {
    if (!this.webhookSecret) return false;
    const timestamp = headers['x-adcp-timestamp'];
    const signature = headers['x-adcp-signature'];
    if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) return false;
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;

    const parsedTimestamp = Number(timestamp);
    if (!Number.isSafeInteger(parsedTimestamp) || Math.abs(Math.floor(Date.now() / 1000) - parsedTimestamp) > 300) {
      return false;
    }

    const expected = `sha256=${createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex')}`;
    const expectedBytes = Buffer.from(expected, 'utf8');
    const actualBytes = Buffer.from(signature, 'utf8');
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
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

    clearTimeout(this.timeoutHandle);

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
    const url = new URL(this.webhookUrl);
    url.searchParams.set('op', this.operationId);
    return url.toString();
  }
}

module.exports = { AsyncWebhookHandler };
