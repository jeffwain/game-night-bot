# Use the official lightweight Node.js 24 Alpine image
FROM node:24-alpine AS base

# Set the working directory
WORKDIR /app

# Install dependencies first (leverage Docker layer caching)
COPY package.json package-lock.json ./
# npm ci + the lockfile makes builds reproducible; --only=production is deprecated.
RUN npm ci --omit=dev

# Copy source files. This includes src/web/public, the control panel's five
# static assets -- there is no build step and nothing to compile.
COPY src/ ./src/

# Create a data directory for mounting external volume
RUN mkdir -p /app/data

# Deliberately runs as root.
#
# `USER node` is better practice in isolation, but this image's only writable
# path is a host-mounted ./data volume. Docker creates that directory owned by
# root on first run, so a non-root process cannot write db.json -- turning a
# clean install into a permissions puzzle for every new user. Running as root
# keeps the mount working everywhere. The container does now listen (the web
# control panel), but it binds a LAN-only, private-address-gated port that
# publishes nothing unless the operator maps it, so the exposure stays small.

# Environment variable defaults
ENV NODE_ENV=production

# The web control panel. Documentation only -- EXPOSE publishes nothing on its
# own, and the panel refuses any request that does not come from a private
# network address unless WEB_ALLOW_REMOTE says otherwise.
EXPOSE 8787

# The entry point command
CMD ["npm", "start"]
