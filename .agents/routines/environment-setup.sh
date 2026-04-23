#!/bin/bash
# Cloud environment setup for adcp-client routines.
# Paste into the "Setup script" field at claude.ai/code/routines.
# Runs as root on Ubuntu 24.04; result is cached ~7 days.

set -euo pipefail

# gh CLI from GitHub's official apt repo.
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y gh

# Install deps. --ignore-scripts blocks preinstall/postinstall hooks
# (security: attacker-crafted PR modifying package.json could otherwise
# execute arbitrary code on the next cache miss).
if [ -f package.json ]; then
  npm ci --prefer-offline --no-audit --no-fund --ignore-scripts
fi

echo "Setup complete."
