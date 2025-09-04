# Use Node.js 18 Alpine for smaller image size
FROM node:18-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Build the source code (JavaScript version)
FROM base AS builder
WORKDIR /app

# Copy source code and dependencies
COPY . .
COPY --from=deps /app/node_modules ./node_modules

# No build needed - we're using plain JavaScript

# Production image
FROM base AS runner
WORKDIR /app

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 adcp

# Copy application files
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/src ./src
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Set production environment
ENV NODE_ENV=production
ENV PORT=8080

# Set correct permissions
USER adcp

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start the server
CMD ["node", "server.js"]