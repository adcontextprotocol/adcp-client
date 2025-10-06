#!/bin/bash

BASE_URL="https://raw.githubusercontent.com/adcontextprotocol/adcp/main/static/schemas/v1"
CACHE_DIR="schemas/cache/latest"

# Create directories
mkdir -p $CACHE_DIR/media-buy
mkdir -p $CACHE_DIR/core
mkdir -p $CACHE_DIR/enums

# Download media-buy schemas
for file in create-media-buy-request.json create-media-buy-response.json; do
  echo "Downloading media-buy/$file..."
  curl -s "$BASE_URL/media-buy/$file" > "$CACHE_DIR/media-buy/$file"
done

# Download core schemas
for file in budget.json targeting.json error.json package.json media-buy.json creative-asset.json product.json; do
  echo "Downloading core/$file..."
  curl -s "$BASE_URL/core/$file" > "$CACHE_DIR/core/$file"
done

# Download enum schemas
for file in pacing.json task-status.json package-status.json media-buy-status.json; do
  echo "Downloading enums/$file..."
  curl -s "$BASE_URL/enums/$file" > "$CACHE_DIR/enums/$file"
done

echo "Done!"
