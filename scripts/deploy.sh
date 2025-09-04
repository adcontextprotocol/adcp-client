#!/bin/bash

# AdCP Testing Framework Deployment Script for Fly.io
set -e

echo "🚀 Deploying AdCP Testing Framework to Fly.io..."

# Check if fly CLI is installed
if ! command -v fly &> /dev/null; then
    echo "❌ Fly CLI is not installed. Install it first:"
    echo "   curl -L https://fly.io/install.sh | sh"
    exit 1
fi

# Check if logged in to Fly.io
if ! fly auth whoami &> /dev/null; then
    echo "❌ Not logged in to Fly.io. Run 'fly auth login' first."
    exit 1
fi

echo "⚠️  IMPORTANT: You need to set your sales agents configuration first!"
echo "   Run this command with your actual agent credentials:"
echo ""
echo "   fly secrets set 'SALES_AGENTS_CONFIG={"
echo "     \"agents\": ["
echo "       {"
echo "         \"id\": \"your_agent_a2a\","
echo "         \"name\": \"Your A2A Agent\","
echo "         \"agent_uri\": \"https://your-agent-endpoint.com\","
echo "         \"protocol\": \"a2a\","
echo "         \"auth_token_env\": \"your-actual-auth-token-here\","
echo "         \"requiresAuth\": true"
echo "       }"
echo "     ]"
echo "   }'"
echo ""

read -p "Have you set SALES_AGENTS_CONFIG with your credentials? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Please set your agent configuration first, then run this script again."
    exit 1
fi

echo "🏗️ Building and deploying..."
fly deploy

echo "🌐 Setting up custom domain..."
echo "Run the following command to add your custom domain:"
echo "fly certs add your-domain.com"

echo "✅ Deployment complete!"
echo "🔗 Your app is available at: https://your-app-name.fly.dev"
echo "📊 Monitor with: fly logs"