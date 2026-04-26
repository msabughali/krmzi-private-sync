# syntax=docker/dockerfile:1.7
#
# Use the official Playwright image so Chromium and ALL of its ~80 OS
# dependencies are pre-installed. This removes the slowest step in the
# previous Dockerfile (`npx playwright install --with-deps chromium`,
# which alone took 2-3 minutes on Coolify) and lets rebuilds finish in
# well under a minute once the base image is cached.
#
# Keep this version pinned to the same minor as `playwright` in
# package.json so the npm-installed library matches the pre-installed
# browser binaries.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

ENV NODE_ENV=production \
    WEB_PORT=8787 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Only `wget` is missing from the base image (used by HEALTHCHECK).
# ca-certificates is already provided.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends wget

# Install Node deps with a persistent npm cache so repeated Coolify
# builds don't redownload tarballs.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Application source. Kept after the dep install so a code-only change
# only invalidates these layers (~5 seconds to rebuild).
COPY src ./src
COPY web ./web
COPY data ./data-seed
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY .env.example ./.env.example

RUN mkdir -p /app/data \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- "http://localhost:${WEB_PORT}/api/health" || exit 1

# Default: run the web UI. The companion worker service overrides this
# with `node src/index.js --loop` in docker-compose.yml.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/webServer.js"]
