#!/bin/bash
# Cloud environment setup for adcp-client routines.
# Paste into the "Setup script" field when creating the routine's
# environment at claude.ai/code/routines. Runs as root on Ubuntu 24.04;
# result is cached ~7 days.

set -euo pipefail

# gh CLI for `gh issue`, `gh pr create`, etc. — not pre-installed.
apt-get update
apt-get install -y gh

# Install deps (Node + npm pre-installed).
if [ -f package.json ]; then
  npm ci --prefer-offline --no-audit --no-fund
fi

echo "Setup complete."
