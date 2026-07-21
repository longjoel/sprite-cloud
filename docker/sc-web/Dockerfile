FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace root files (lock + workspace config)
COPY pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy package.json for each workspace member
COPY sc-web/package.json sc-web/
COPY sc-player/package.json sc-player/

# Install deps for all workspace members
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    pnpm install --frozen-lockfile --ignore-scripts || pnpm install --no-frozen-lockfile

# Accept build deps and rebuild
RUN pnpm rebuild esbuild sharp 2>/dev/null || true

# Work from sc-web subdirectory
WORKDIR /app/sc-web

# Entrypoint: push DB schema then start Next.js dev server
COPY docker/sc-web/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
CMD ["/entrypoint.sh"]
