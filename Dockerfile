# Use the official lightweight Node.js 24 Alpine image
FROM node:24-alpine AS base

# Set the working directory
WORKDIR /app

# Install dependencies first (leverage Docker layer caching)
COPY package.json package-lock.json ./
# npm ci + the lockfile makes builds reproducible; --only=production is deprecated.
RUN npm ci --omit=dev

# Copy source files
COPY src/ ./src/

# Create a data directory for mounting external volume
RUN mkdir -p /app/data

# Deliberately runs as root.
#
# `USER node` is better practice in isolation, but this image's only writable
# path is a host-mounted ./data volume. Docker creates that directory owned by
# root on first run, so a non-root process cannot write db.json -- turning a
# clean install into a permissions puzzle for every new user. Running as root
# keeps the mount working everywhere; the container has no network listener and
# no untrusted input path, so the exposure is small.

# Environment variable defaults
ENV NODE_ENV=production

# The entry point command
CMD ["npm", "start"]
